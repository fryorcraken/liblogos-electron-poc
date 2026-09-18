// EXPERIMENT 3 — event subscription, the half of the 0.3.0 inventory with no
// evidence behind it.
//
// docs/0.3.0-inventory.md §5.2 says so plainly: exp_call.cc proved the CALL
// path, and nothing has ever exercised the EVENT path. The inventory's ~35-line
// estimate for item 6 is a guess until this runs. Two things could go wrong and
// neither shows up by reading source:
//
//   1. onEventWhenAvailable() may never ARM. A module is marked loaded before it
//      publishes its object (the window core_service_impl.cpp:598 documents),
//      and a subscription taken in that window is deferred, not refused. If it
//      never arms we would see silence — which looks identical to "the module
//      emitted nothing".
//   2. The callback arrives on whichever thread Qt services it on. Reaching JS
//      from there needs a ThreadSafeFunction, and if that thread turns out to be
//      the JS thread itself the TSFN is still correct but the reentrancy risk in
//      §5.5 becomes real.
//
// SO THE EXPERIMENT SEPARATES THEM. `onArmed` is reported to JS distinctly from
// event delivery, and every callback reports the OS thread it ran on. "Armed but
// no events" and "never armed" are different results with different fixes, and a
// test that could not tell them apart would not be worth running.
//
// Built by `make exp-event`. Nothing here is part of the shipped addon.
#include <napi.h>

#include <QCoreApplication>
#include <QEventLoop>
#include <QString>
#include <QVariant>
#include <QVariantList>

extern "C" {
#include "logos_core.h"
}

#include <logos_api.h>
#include <logos_api_client.h>
#include <logos_call_error.h>
#include <logos_json_convert.h>

#include <cstdio>
#include <sstream>
#include <string>
#include <thread>

namespace {

LogosAPI* g_api = nullptr;

void EnsureQtApp() {
  if (QCoreApplication::instance() != nullptr) return;
  static int argc = 1;
  static char arg0[] = "exp-event";
  static char* argv[] = {arg0, nullptr};
  new QCoreApplication(argc, argv);
}

std::string ThisThreadId() {
  std::ostringstream os;
  os << std::this_thread::get_id();
  return os.str();
}

// Same bring-up as exp_call.cc — deliberately identical, so any difference in
// outcome is the subscription and not the setup.
Napi::Value Setup(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const std::string modulesDir = info[0].As<Napi::String>().Utf8Value();
  const std::string persistDir = info[1].As<Napi::String>().Utf8Value();
  const std::string origin = info.Length() > 2 && info[2].IsString()
                                 ? info[2].As<Napi::String>().Utf8Value()
                                 : std::string("core_service");

  EnsureQtApp();
  static char arg0[] = "exp-event";
  static char* argv[] = {arg0, nullptr};
  logos_core_init(1, argv);
  logos_core_add_modules_dir(modulesDir.c_str());
  logos_core_set_persistence_base_path(persistDir.c_str());
  logos_core_start();

  g_api = new LogosAPI(QString::fromStdString(origin));
  std::fprintf(stderr, "[exp-event] LogosAPI(origin=%s) built on thread %s\n",
               origin.c_str(), ThisThreadId().c_str());
  return env.Undefined();
}

Napi::Value LoadModule(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const std::string name = info[0].As<Napi::String>().Utf8Value();
  return Napi::Boolean::New(
      env, logos_core_load_module(name.c_str(), LOGOS_LOAD_REQUIRED_DEPS) == 1);
}

// watch(module, event, cb) -> subscription id (0 = refused)
//
// cb receives one JSON string. A single JSON argument rather than positional
// N-API values because the payload shape is the module's business, and this
// experiment should not be in the business of guessing it.
//
// Mirrors core_service_impl.cpp:562-622's watchModuleEvents in the one respect
// that matters: onEventWhenAvailable, NOT requestObject()+onEvent(). The comment
// at :598 is explicit that the naive form silently refuses during the window
// where a module is marked loaded but has not published yet — which is exactly
// the window an app subscribes in.
Napi::Value Watch(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (g_api == nullptr) throw Napi::Error::New(env, "call setup() first");

  const std::string module = info[0].As<Napi::String>().Utf8Value();
  const std::string event = info[1].As<Napi::String>().Utf8Value();
  if (info.Length() < 3 || !info[2].IsFunction()) {
    throw Napi::TypeError::New(env, "a callback function is required");
  }

  LogosAPIClient* client = g_api->getClient(QString::fromStdString(module));
  if (client == nullptr) throw Napi::Error::New(env, "getClient returned null");

  // Unlimited queue (0) and NonBlockingCall below, for the reason StartLogCapture
  // in src/addon.cc spells out: the JS thread can be blocked inside a
  // synchronous liblogos call when an event arrives, and a BlockingCall would
  // then wait on the very thread that has to drain it.
  auto tsfn = Napi::ThreadSafeFunction::New(
      env, info[2].As<Napi::Function>(), "exp-event-watch", 0, 1);

  // Both callbacks capture `tsfn` by value; the TSFN is refcounted, and neither
  // is released here on purpose — this is a throwaway experiment whose process
  // exits at the end, and Release()ing from the Qt side would need lifetime
  // rules the experiment is not trying to establish.
  const quint64 id = client->onEventWhenAvailable(
      QString::fromStdString(module), QString::fromStdString(event),
      [tsfn](const QString& name, const QVariantList& args) {
        nlohmann::json payload;
        payload["kind"] = "event";
        payload["event"] = name.toStdString();
        payload["thread"] = ThisThreadId();
        payload["args"] = logos::qvariantToNlohmann(QVariant(args));
        const std::string dumped = payload.dump();
        tsfn.NonBlockingCall([dumped](Napi::Env cb_env, Napi::Function cb) {
          cb.Call({Napi::String::New(cb_env, dumped)});
        });
      },
      // onArmed answers the FIRST question: did the subscription ever go live?
      // Reported separately from events so "armed, module emitted nothing" and
      // "never armed" cannot be confused for each other.
      [tsfn](bool armed) {
        nlohmann::json payload;
        payload["kind"] = "armed";
        payload["armed"] = armed;
        payload["thread"] = ThisThreadId();
        const std::string dumped = payload.dump();
        tsfn.NonBlockingCall([dumped](Napi::Env cb_env, Napi::Function cb) {
          cb.Call({Napi::String::New(cb_env, dumped)});
        });
      });

  std::fprintf(stderr,
               "[exp-event] onEventWhenAvailable(%s::%s) -> id=%llu (subscribed "
               "on thread %s)\n",
               module.c_str(), event.c_str(),
               static_cast<unsigned long long>(id), ThisThreadId().c_str());
  return Napi::Number::New(env, static_cast<double>(id));
}

// Diagnostics: "<object>::<event>" for every subscription still DEFERRED. If
// this stays non-empty, the subscription never armed and no amount of waiting
// for events means anything.
Napi::Value Pending(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (g_api == nullptr) throw Napi::Error::New(env, "call setup() first");
  const std::string module = info[0].As<Napi::String>().Utf8Value();
  LogosAPIClient* client = g_api->getClient(QString::fromStdString(module));
  if (client == nullptr) return Napi::Array::New(env);

  const QStringList pending = client->pendingEventSubscriptions();
  Napi::Array out = Napi::Array::New(env);
  uint32_t i = 0;
  for (const QString& entry : pending) {
    out.Set(i++, Napi::String::New(env, entry.toStdString()));
  }
  return out;
}

// The same synchronous call exp_call.cc makes. Present here so one process can
// subscribe AND then trigger — an event experiment that cannot make the module
// do anything would only ever prove that nothing happened.
Napi::Value CallModule(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (g_api == nullptr) throw Napi::Error::New(env, "call setup() first");

  const std::string module = info[0].As<Napi::String>().Utf8Value();
  const std::string method = info[1].As<Napi::String>().Utf8Value();
  const std::string argsJson = info.Length() > 2 && info[2].IsString()
                                   ? info[2].As<Napi::String>().Utf8Value()
                                   : std::string("[]");

  nlohmann::json args = nlohmann::json::parse(argsJson, nullptr, false);
  if (args.is_discarded() || !args.is_array()) args = nlohmann::json::array();

  LogosAPIClient* client = g_api->getClient(QString::fromStdString(module));
  if (client == nullptr) throw Napi::Error::New(env, "getClient returned null");

  logos::CallError err;
  const QVariant ret = client->invokeRemoteMethod(
      QString::fromStdString(module), QString::fromStdString(method),
      logos::nlohmannArgsToQVariantList(args), Timeout(), &err);

  nlohmann::json out;
  out["ok"] = err.ok();
  out["code"] = err.code;
  out["message"] = err.message;
  out["value"] = logos::qvariantToNlohmann(ret);
  return Napi::String::New(env, out.dump());
}

Napi::Value Tick(const Napi::CallbackInfo& info) {
  QCoreApplication::processEvents(QEventLoop::AllEvents, 5);
  return info.Env().Undefined();
}

Napi::Object InitAddon(Napi::Env env, Napi::Object exports) {
  exports.Set("setup", Napi::Function::New(env, Setup));
  exports.Set("loadModule", Napi::Function::New(env, LoadModule));
  exports.Set("watch", Napi::Function::New(env, Watch));
  exports.Set("pending", Napi::Function::New(env, Pending));
  exports.Set("callModule", Napi::Function::New(env, CallModule));
  exports.Set("tick", Napi::Function::New(env, Tick));
  return exports;
}

}  // namespace

NODE_API_MODULE(exp_event, InitAddon)
