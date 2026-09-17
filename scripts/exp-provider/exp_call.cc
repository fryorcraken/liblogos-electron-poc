// EXPERIMENT 2 — the OTHER half of 0.3.0, and the more valuable one.
//
// exp_addon.cc answered "can the addon PUBLISH a provider and serve RPC?".
// This answers "can the addon CALL a module directly?" — i.e. can it do what
// CoreServiceImpl::callModuleMethod does (core_service_impl.cpp:494), which is
// just:
//
//     LogosAPIClient* c = api->getClient(module);
//     c->invokeRemoteMethod(module, method, args, Timeout(), &err);
//
// If this works, 0.3.0 does NOT need a published core_service at all. The
// gateway exists so an OUT-OF-PROCESS client has something to talk to; an
// in-process caller can skip the whole RPC surface and call the module
// directly. That would collapse the C++ inventory enormously.
//
// Built by `make exp-call`. Nothing here is part of the shipped addon.
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
#include <string>

namespace {

LogosAPI* g_api = nullptr;

void EnsureQtApp() {
  if (QCoreApplication::instance() != nullptr) return;
  static int argc = 1;
  static char arg0[] = "exp-call";
  static char* argv[] = {arg0, nullptr};
  new QCoreApplication(argc, argv);
}

// Stand up liblogos exactly as src/addon.cc does, then build the LogosAPI the
// call path needs. "electron_poc" is the ORIGIN identity — the name this
// process calls as.
Napi::Value Setup(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const std::string modulesDir = info[0].As<Napi::String>().Utf8Value();
  const std::string persistDir = info[1].As<Napi::String>().Utf8Value();
  const std::string origin =
      info.Length() > 2 && info[2].IsString()
          ? info[2].As<Napi::String>().Utf8Value()
          : std::string("core_service");

  EnsureQtApp();
  static char arg0[] = "exp-call";
  static char* argv[] = {arg0, nullptr};
  logos_core_init(1, argv);
  logos_core_add_modules_dir(modulesDir.c_str());
  logos_core_set_persistence_base_path(persistDir.c_str());
  logos_core_start();

  // No transport set: the DEFAULT (LocalSocket / QtRO) is what modules already
  // publish on, and an in-process caller can speak it — unlike the JS SDK,
  // which is why 0.2.0 had to force TCP everywhere. That is the crux.
  g_api = new LogosAPI(QString::fromStdString(origin));
  std::fprintf(stderr, "[exp-call] LogosAPI(origin=%s) built\n", origin.c_str());
  return env.Undefined();
}

Napi::Value LoadModule(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const std::string name = info[0].As<Napi::String>().Utf8Value();
  return Napi::Boolean::New(
      env, logos_core_load_module(name.c_str(), LOGOS_LOAD_REQUIRED_DEPS) == 1);
}

// THE CALL. Mirrors CoreServiceImpl::callModuleMethod's core, minus the
// envelope shaping — the point is only whether the invocation lands.
//
// callModule(module, method, argsJson) -> JSON string
Napi::Value CallModule(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (g_api == nullptr) throw Napi::Error::New(env, "call setup() first");

  const std::string module = info[0].As<Napi::String>().Utf8Value();
  const std::string method = info[1].As<Napi::String>().Utf8Value();
  const std::string argsJson =
      info.Length() > 2 && info[2].IsString()
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
  out["origin"] = err.origin;
  out["value"] = logos::qvariantToNlohmann(ret);
  return Napi::String::New(env, out.dump());
}

// A pump, same as exp_addon: the invocation is synchronous from JS's point of
// view, but QtRO still needs the loop serviced to complete a round trip.
Napi::Value Tick(const Napi::CallbackInfo& info) {
  QCoreApplication::processEvents(QEventLoop::AllEvents, 5);
  return info.Env().Undefined();
}

Napi::Object InitAddon(Napi::Env env, Napi::Object exports) {
  exports.Set("setup", Napi::Function::New(env, Setup));
  exports.Set("loadModule", Napi::Function::New(env, LoadModule));
  exports.Set("callModule", Napi::Function::New(env, CallModule));
  exports.Set("tick", Napi::Function::New(env, Tick));
  return exports;
}

}  // namespace

NODE_API_MODULE(exp_call, InitAddon)
