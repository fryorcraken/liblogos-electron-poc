// N-API bindings for liblogos_core's C ABI.
//
// WHY C++ AND NOT A PURE-JS FFI: liblogos is Qt underneath, and a
// QCoreApplication must exist before logos_core_start(). Only C++ can construct
// one, so the binding layer has to be compiled anyway — at which point doing the
// whole binding here costs nothing extra and keeps one language in the path.
//
// THREADING. logos_core.h is explicit that core's outbound calls run on the
// thread that called logos_core_start(), and that a load off that thread
// completes its capability registration asynchronously. Every function here is
// therefore synchronous and runs on the thread that called it — which, for this
// addon, is always Electron's main thread. That makes loadModule() block the UI
// for the duration of a module bring-up. Acceptable for a PoC and honest about
// the constraint; a real app would move the runtime to its own thread that owns
// the Qt event loop, or to a helper process (see README).
//
// MEMORY. The char** / char* returns are documented as caller-freed. The array
// accessors free both the strings and the array itself; free() rather than
// delete[] because the allocation crosses the C ABI.
#include <napi.h>

#include <QCoreApplication>
#include <QEventLoop>
#include <QString>
#include <QVariant>
#include <QVariantList>

#include <unistd.h>

#include <cstdlib>
#include <string>
#include <thread>
#include <vector>

extern "C" {
#include "logos_core.h"
}

// 0.3.0: the in-process call and event path. These are C++ (not the C ABI
// above), which is the ABI commitment docs/0.3.0-inventory.md §5.9 records —
// a liblogos bump can now break this addon at load time rather than at compile
// time. Accepted deliberately: invokeRemoteMethod is a virtual method over
// QRemoteObjects and there is no C ABI for it.
#include <logos_api.h>
#include <logos_api_client.h>
#include <logos_call_error.h>
#include <logos_json_convert.h>

namespace {

// The QCoreApplication liblogos needs. Deliberately leaked: it must outlive
// every call into core, and there is no teardown hook here that would outlive
// it. Qt keeps references to argc/argv for the application's lifetime, so both
// are static rather than stack temporaries.
void EnsureQtApp() {
  if (QCoreApplication::instance() != nullptr) {
    return;
  }
  static int argc = 1;
  static char arg0[] = "liblogos-electron-poc";
  static char* argv[] = {arg0, nullptr};
  new QCoreApplication(argc, argv);
}

// Guards against driving the lifecycle out of order. logos_core_start() before
// init, or a load before start, is undefined behaviour down in core; catching it
// here turns a crash into a JS exception naming the mistake.
bool g_initialized = false;
bool g_started = false;

// The 0.3.0 call path. Built in start(), never torn down — same reasoning as the
// QCoreApplication above: it must outlive every call, and cleanup() is the only
// teardown hook this addon has.
//
// "core_service" is the ORIGIN identity — the name this process calls AS, not a
// module it talks to. module_manager.cpp keeps kTrustedCallers = {"core",
// "core_service"}, "always allowed past the dependency check, so they're never
// locked out", and the daemon registers its gateway under exactly that name. So
// calling as core_service is what the reference implementation effectively does.
//
// No transport is set. That is the crux of 0.3.0: the DEFAULT LocalSocket/QtRO
// transport is the one every module already publishes on and uses to talk to its
// peers, and an in-process Qt participant can speak it. The plain-transport
// limitation that blocked 0.2.0's JS SDK applied only to Qt-FREE clients.
LogosAPI* g_api = nullptr;

void RequireState(const Napi::Env& env, bool condition, const char* message) {
  if (!condition) {
    throw Napi::Error::New(env, message);
  }
}

// delete[], NOT free(). logos_core_* allocates every string it hands back with
// new[], never malloc: module_manager.cpp's toNullTerminatedArray does
// `new char*[]` plus a `new char[]` per element, and getModulesInfoCStr /
// getModuleStats each `new char[]`. Mixing allocators is undefined behaviour —
// it happened not to crash here, which is the worst way for it to behave.
//
// Both other hosts that drain this C API carry the same note and the same fix:
// logos-logoscore-cli's core_service_impl.cpp:28 and logos-basecamp's
// CoreModuleManager.cpp.

// Consume a null-terminated char** from core into a JS array, freeing as it goes.
Napi::Array TakeStringArray(const Napi::Env& env, char** owned) {
  Napi::Array out = Napi::Array::New(env);
  if (owned == nullptr) {
    return out;
  }
  uint32_t i = 0;
  for (char** cursor = owned; *cursor != nullptr; ++cursor, ++i) {
    out.Set(i, Napi::String::New(env, *cursor));
    delete[] *cursor;
  }
  delete[] owned;
  return out;
}

// Consume a caller-freed char* from core into a JS string. A NULL return is
// mapped to null rather than "" — core uses NULL to mean "not found", which is
// not the same as an empty value.
Napi::Value TakeString(const Napi::Env& env, char* owned) {
  if (owned == nullptr) {
    return env.Null();
  }
  Napi::Value out = Napi::String::New(env, owned);
  delete[] owned;
  return out;
}

std::string RequireStringArg(const Napi::CallbackInfo& info, size_t index, const char* name) {
  if (info.Length() <= index || !info[index].IsString()) {
    throw Napi::TypeError::New(info.Env(), std::string(name) + " (string) is required");
  }
  return info[index].As<Napi::String>().Utf8Value();
}

// --- lifecycle -------------------------------------------------------------

Napi::Value Init(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!g_initialized) {
    // Qt first: core's init touches Qt types, so the application object has to
    // exist before it, not merely before start().
    EnsureQtApp();

    // Core takes argc/argv in the C main() shape. It is not given Electron's
    // real argv: those are Chromium's switches, which mean nothing to core and
    // which Qt would try to parse.
    static char arg0[] = "liblogos-electron-poc";
    static char* argv[] = {arg0, nullptr};
    logos_core_init(1, argv);
    g_initialized = true;
  }
  return env.Undefined();
}

Napi::Value AddModulesDir(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  RequireState(env, g_initialized, "call init() before addModulesDir()");
  const std::string dir = RequireStringArg(info, 0, "modulesDir");
  logos_core_add_modules_dir(dir.c_str());
  return env.Undefined();
}

// Each module instance gets {path}/{module_name}/{instance_id}/. Without it the
// RLN membership module has nowhere to put a keystore and says so. Must be
// called before start().
Napi::Value SetPersistenceBasePath(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  RequireState(env, g_initialized, "call init() before setPersistenceBasePath()");
  RequireState(env, !g_started, "call setPersistenceBasePath() before start()");
  const std::string dir = RequireStringArg(info, 0, "path");
  logos_core_set_persistence_base_path(dir.c_str());
  return env.Undefined();
}

// Give a module a transport set of its own, so something outside this process
// can reach it. Modules otherwise inherit the global default (LocalSocket, i.e.
// QLocalSocket via QRemoteObjects), which only a Qt consumer can speak —
// logos-js-sdk talks plain TCP.
//
// `transport_set_json` is a JSON array of LogosTransportConfig; see
// logos_transport_config.h. Must be called BEFORE the module is loaded.
Napi::Value SetModuleTransports(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  RequireState(env, g_initialized, "call init() before setModuleTransports()");
  const std::string name = RequireStringArg(info, 0, "moduleName");
  const std::string json = RequireStringArg(info, 1, "transportSetJson");
  logos_core_set_module_transports(name.c_str(), json.c_str());
  return env.Undefined();
}

Napi::Value Start(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  RequireState(env, g_initialized, "call init() before start()");
  if (!g_started) {
    logos_core_start();
    g_started = true;
    // After start(), so the runtime it will talk to exists. Constructing it on
    // this thread matters: LogosAPI's Qt objects are affined to their creating
    // thread and are only ever serviced by an event loop running there, which
    // is what tick() below provides.
    g_api = new LogosAPI(QStringLiteral("core_service"));
  }
  return env.Undefined();
}

// --- the Qt event loop --------------------------------------------------------

// PUMP Qt'S LOOP FROM A LIBUV TIMER. src/index.js drives this from a
// setInterval; the whole mechanism is five lines and it is not optional.
//
// 0.1.0 never ran a Qt event loop at all, because liblogos' load calls are
// synchronous and did not need one. A QtRO round trip does: nothing completes
// unless the loop is serviced.
//
// WHY EXPLICITLY, when Electron appears not to need it. Electron links glib, and
// Qt on Linux defaults to QEventDispatcherGlib, which attaches its sources to
// the same process-default GMainContext that Chromium's main-process message
// loop drives — so Chromium pumps Qt's events for free. That was measured, not
// assumed, and so was its fragility: with QT_NO_GLIB=1, Qt moves to its own UNIX
// dispatcher and the unpumped configuration flips from pass to fail while
// nothing else changes. Explicit pumping passes in all four configurations
// (Node and Electron, glib and no-glib). Depending on the coincidence would make
// correctness hostage to an Electron upgrade or a non-Linux port, and the cost
// of not depending on it is one timer. See docs/0.3.0-inventory.md §1.
//
// A DEDICATED QT THREAD DOES NOT WORK, and is the obvious-looking alternative:
// the Qt objects are created on the thread that called start(), and a
// QEventLoop::exec() on a different thread never touches them. Measured too —
// it fails everywhere.
Napi::Value Tick(const Napi::CallbackInfo& info) {
  // The 5 ms cap bounds how long one tick can hold the JS thread. It is not a
  // characterised number: §5.4 of the inventory is honest that neither the
  // interval nor this budget has been measured for latency or CPU cost.
  QCoreApplication::processEvents(QEventLoop::AllEvents, 5);
  return info.Env().Undefined();
}

// --- calling a module ---------------------------------------------------------

// Shared by the async worker and the event subscription: the two-line core of
// CoreServiceImpl::callModuleMethod (core_service_impl.cpp:494), minus the
// envelope shaping that only a wire protocol needs. In-process, logos::CallError
// already carries code/message/origin separately from the value, so there is
// nothing to disambiguate.
LogosAPIClient* ClientFor(const std::string& module) {
  if (g_api == nullptr) return nullptr;
  return g_api->getClient(QString::fromStdString(module));
}

// invokeRemoteMethod BLOCKS, with a 20 s default Timeout(). On Electron's main
// thread that is a frozen UI for up to twenty seconds, so this is an AsyncWorker
// rather than a synchronous binding — the inventory lists it as item 5 and is
// explicit that it is not optional polish.
//
// WHAT RUNS WHERE. Execute() runs on a libuv worker thread and does the blocking
// call; OnOK() runs back on the JS thread and resolves the promise. The QtRO
// round trip is therefore started from a thread that did NOT create the Qt
// objects — which works because invokeRemoteMethod marshals to the owner thread
// internally, and that thread is being pumped by tick(). If the pump is not
// running, this hangs for the full timeout and then reports a failure, which is
// the honest symptom rather than a deadlock.
class CallModuleWorker : public Napi::AsyncWorker {
 public:
  CallModuleWorker(Napi::Env env, std::string module, std::string method,
                   nlohmann::json args)
      : Napi::AsyncWorker(env),
        m_deferred(Napi::Promise::Deferred::New(env)),
        m_module(std::move(module)),
        m_method(std::move(method)),
        m_args(std::move(args)) {}

  Napi::Promise Promise() { return m_deferred.Promise(); }

  void Execute() override {
    LogosAPIClient* client = ClientFor(m_module);
    if (client == nullptr) {
      SetError("no client for module (was start() called?)");
      return;
    }
    logos::CallError err;
    const QVariant ret = client->invokeRemoteMethod(
        QString::fromStdString(m_module), QString::fromStdString(m_method),
        logos::nlohmannArgsToQVariantList(m_args), Timeout(), &err);

    // The CallError is reported as a rejected promise rather than folded into
    // the value: a module that legitimately returns null and a call that never
    // reached the module are different outcomes, and JS should not have to
    // guess which it got.
    if (!err.ok()) {
      SetError(err.code + ": " + err.message +
               (err.origin.empty() ? std::string() : " (origin " + err.origin + ")"));
      return;
    }
    m_result = logos::qvariantToNlohmann(ret).dump();
  }

  void OnOK() override {
    Napi::HandleScope scope(Env());
    m_deferred.Resolve(Napi::String::New(Env(), m_result));
  }

  void OnError(const Napi::Error& err) override {
    Napi::HandleScope scope(Env());
    m_deferred.Reject(err.Value());
  }

 private:
  Napi::Promise::Deferred m_deferred;
  std::string m_module;
  std::string m_method;
  nlohmann::json m_args;
  std::string m_result;
};

// callModule(module, method, argsJson) -> Promise<string>
//
// Args and result cross as JSON TEXT, not N-API values. The marshalling itself
// is logos::nlohmannArgsToQVariantList / qvariantToNlohmann — already written
// upstream in liblogos_protocol, and re-implementing the mapping here would only
// add a place for it to drift from what the modules actually accept.
Napi::Value CallModule(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  RequireState(env, g_started, "call start() before callModule()");
  const std::string module = RequireStringArg(info, 0, "moduleName");
  const std::string method = RequireStringArg(info, 1, "methodName");

  std::string argsJson = "[]";
  if (info.Length() > 2 && !info[2].IsUndefined() && !info[2].IsNull()) {
    argsJson = RequireStringArg(info, 2, "argsJson");
  }
  nlohmann::json args = nlohmann::json::parse(argsJson, nullptr, false);
  if (args.is_discarded() || !args.is_array()) {
    throw Napi::TypeError::New(env, "argsJson must be a JSON array");
  }

  auto* worker = new CallModuleWorker(env, module, method, std::move(args));
  worker->Queue();
  return worker->Promise();
}

// --- watching a module's events -----------------------------------------------

// watchModule(module, event, callback) -> subscription id (0 = refused)
//
// onEventWhenAvailable, NEVER requestObject()+onEvent(). That is the one lesson
// worth lifting from CoreServiceImpl::watchModuleEvents, and its comment at
// core_service_impl.cpp:598 explains it at length: a module is reported LOADED
// once its plugin is in the host, and publishes its object afterwards. Cold,
// that gap is seconds. requestObject() is one-shot and is silently refused
// inside it, so the naive form fails for a module that was just loaded — and
// because nothing retries, it fails quietly. onEventWhenAvailable holds the
// subscription, arms it when the object appears, and re-arms it across a
// reconnect. Verified here by subscribing with no settling delay at all:
// `make exp-event` arms every time.
//
// AN EMPTY EVENT NAME MEANS EVERY EVENT on the object, which is what a log pane
// wants and what the UI passes. It also cannot be misspelled — and misspelling
// matters more than it looks, because onEventWhenAvailable ARMS on an event name
// the module never emits. Arming proves the module was reached, not that the
// name is real, so a typo is indistinguishable from a quiet module. That cost
// this repo a run; see docs/0.3.0-inventory.md §2b.
Napi::Value WatchModule(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  RequireState(env, g_started, "call start() before watchModule()");
  const std::string module = RequireStringArg(info, 0, "moduleName");

  std::string event;
  if (info.Length() > 1 && !info[1].IsUndefined() && !info[1].IsNull()) {
    event = RequireStringArg(info, 1, "eventName");
  }
  if (info.Length() < 3 || !info[2].IsFunction()) {
    throw Napi::TypeError::New(env, "a callback function is required");
  }

  LogosAPIClient* client = ClientFor(module);
  if (client == nullptr) throw Napi::Error::New(env, "no client for module");

  // Unlimited queue (0), and NonBlockingCall below, for exactly the reason
  // StartLogCapture documents: the JS thread can be sitting inside a
  // synchronous liblogos call when an event arrives, and a BlockingCall would
  // wait on the very thread that has to drain the queue.
  //
  // In practice these callbacks arrive ON the JS thread — processEvents() from
  // tick() services Qt objects affined to the thread that created them, which
  // is this one. The ThreadSafeFunction stays regardless: nothing in
  // onEventWhenAvailable's std::function signature promises that, and a TSFN
  // used from the JS thread is correct, merely redundant.
  auto tsfn = Napi::ThreadSafeFunction::New(env, info[2].As<Napi::Function>(),
                                            "logos-module-events", 0, 1);

  const quint64 id = client->onEventWhenAvailable(
      QString::fromStdString(module), QString::fromStdString(event),
      [tsfn](const QString& name, const QVariantList& args) {
        nlohmann::json payload;
        payload["event"] = name.toStdString();
        payload["args"] = logos::qvariantToNlohmann(QVariant(args));
        const std::string dumped = payload.dump();
        tsfn.NonBlockingCall([dumped](Napi::Env cb_env, Napi::Function cb) {
          cb.Call({Napi::String::New(cb_env, dumped)});
        });
      });

  // The TSFN is deliberately never Release()d. A subscription lives for the
  // life of the process here, and cancelEventSubscription() does NOT detach the
  // callback from the shared handle (LogosAPIConsumer offers no per-callback
  // removal) — so releasing on cancel would leave the Qt side holding a TSFN it
  // may still call. The honest cost is one retained function per watch; the
  // alternative needs lifetime rules this PoC has no way to test.
  return Napi::Number::New(env, static_cast<double>(id));
}

Napi::Value Cleanup(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (g_started || g_initialized) {
    // DRAIN BEFORE TEARING DOWN. CoreServiceImpl::shutdown
    // (core_service_impl.cpp:656-695) records the lesson: ending the loop
    // without draining loses whatever is still buffered — in its case the
    // reply to the very call that asked for the shutdown. Here the JS-side
    // pump has already been stopped by the time this runs, so this is the last
    // chance for anything in flight (a stop() reply, a final event) to be
    // serviced. 50 ms is a guess, not a measurement; it is bounded so a wedged
    // queue cannot hang the quit.
    QCoreApplication::processEvents(QEventLoop::AllEvents, 50);
    logos_core_cleanup();
    g_started = false;
    g_initialized = false;
    // g_api is deliberately NOT deleted. Its Qt objects are affined to this
    // thread and may still be referenced by a subscription the runtime has not
    // finished unwinding; leaking it at process exit is strictly safer than
    // racing core's own teardown, and this is the last thing the process does.
  }
  return env.Undefined();
}

// --- modules ---------------------------------------------------------------

// loadModule(name, deps = LOAD_REQUIRED_DEPS) -> boolean
//
// BLOCKS until the module's plugin reports loaded in its host process. Returns
// core's own answer unchanged: true also covers "was already loaded", which the
// header calls out as load-bearing for callers using it as a guard.
Napi::Value LoadModule(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  RequireState(env, g_started, "call start() before loadModule()");
  const std::string name = RequireStringArg(info, 0, "moduleName");

  LogosLoadDeps deps = LOGOS_LOAD_REQUIRED_DEPS;
  if (info.Length() > 1 && !info[1].IsUndefined()) {
    if (!info[1].IsNumber()) {
      throw Napi::TypeError::New(env, "deps must be one of the LOAD_* constants");
    }
    const int32_t raw = info[1].As<Napi::Number>().Int32Value();
    if (raw < LOGOS_LOAD_MODULE_ONLY || raw > LOGOS_LOAD_REQUIRED_AND_OPTIONAL) {
      throw Napi::RangeError::New(env, "deps must be one of the LOAD_* constants");
    }
    deps = static_cast<LogosLoadDeps>(raw);
  }

  return Napi::Boolean::New(env, logos_core_load_module(name.c_str(), deps) == 1);
}

Napi::Value UnloadModule(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  RequireState(env, g_started, "call start() before unloadModule()");
  const std::string name = RequireStringArg(info, 0, "moduleName");
  bool withDependents = false;
  if (info.Length() > 1 && !info[1].IsUndefined()) {
    withDependents = info[1].ToBoolean().Value();
  }
  return Napi::Boolean::New(env, logos_core_unload_module(name.c_str(), withDependents) == 1);
}

Napi::Value KnownModules(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  RequireState(env, g_initialized, "call init() before knownModules()");
  return TakeStringArray(env, logos_core_get_known_modules());
}

Napi::Value LoadedModules(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  RequireState(env, g_initialized, "call init() before loadedModules()");
  return TakeStringArray(env, logos_core_get_loaded_modules());
}

// Returns the raw JSON string from core. Parsing is left to JS: it has a real
// JSON parser, and re-encoding through N-API types here would only add a place
// for the shape to drift from what the header documents.
Napi::Value ModulesInfoJson(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  RequireState(env, g_initialized, "call init() before modulesInfoJson()");
  return TakeString(env, logos_core_get_modules_info());
}

// Fetch a capability token from core's token manager.
//
// Needed because an out-of-process consumer over a PLAIN transport cannot run
// the capability handshake: the module logs "PlainTransportHost::publishObject:
// expected ModuleProxy for <module>__handshake (plain transport only publishes
// ModuleProxy for now)", and every invocation then hangs waiting for a token
// that never arrives. Handing the token to the SDK's saveToken() lets it skip
// the handshake entirely.
//
// Returns null when the key is unknown.
Napi::Value GetToken(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  RequireState(env, g_initialized, "call init() before getToken()");
  const std::string key = RequireStringArg(info, 0, "key");
  return TakeString(env, logos_core_get_token(key.c_str()));
}

Napi::Value RefreshModules(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  RequireState(env, g_initialized, "call init() before refreshModules()");
  logos_core_refresh_modules();
  return env.Undefined();
}

// --- log capture ------------------------------------------------------------

// liblogos logs through spdlog, and the module hosts are separate processes
// whose output core forwards — all of it written straight to file descriptors 1
// and 2. None of it passes through Node, so JS cannot see it by wrapping
// process.stdout.write; in a packaged app it goes nowhere the user can read.
//
// So both fds are redirected into a pipe. A reader thread pulls from the pipe
// and hands each chunk to JS through a ThreadSafeFunction, while also writing it
// back to the REAL stdout (kept as a dup) so the terminal still shows
// everything — `make verify` and CI depend on that.
bool g_capturing = false;

Napi::Value StartLogCapture(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (g_capturing) {
    return env.Undefined();
  }
  if (info.Length() < 1 || !info[0].IsFunction()) {
    throw Napi::TypeError::New(env, "a callback function is required");
  }

  int pipe_fds[2];
  if (pipe(pipe_fds) != 0) {
    throw Napi::Error::New(env, "pipe() failed");
  }

  // Keep the real stdout so output still reaches the terminal.
  const int real_stdout = dup(STDOUT_FILENO);
  if (real_stdout < 0) {
    close(pipe_fds[0]);
    close(pipe_fds[1]);
    throw Napi::Error::New(env, "dup(stdout) failed");
  }

  // Point both fds at the pipe's write end.
  dup2(pipe_fds[1], STDOUT_FILENO);
  dup2(pipe_fds[1], STDERR_FILENO);
  close(pipe_fds[1]);

  // Unlimited queue (0): the main thread is blocked inside loadModule() for the
  // whole bring-up, so the queue has to absorb everything core logs in the
  // meantime and drain once the thread is free again.
  auto tsfn = Napi::ThreadSafeFunction::New(env, info[0].As<Napi::Function>(),
                                            "logos-log-capture", 0, 1);

  std::thread([read_fd = pipe_fds[0], real_stdout, tsfn]() mutable {
    char buffer[4096];
    ssize_t n;
    while ((n = read(read_fd, buffer, sizeof(buffer))) > 0) {
      // Echo to the terminal first, so ordering there matches what was written.
      ssize_t written = 0;
      while (written < n) {
        const ssize_t w = write(real_stdout, buffer + written, n - written);
        if (w <= 0) break;
        written += w;
      }
      // NonBlockingCall, not BlockingCall. loadModule() blocks the main thread
      // for the whole module bring-up, which is exactly when core logs most —
      // and a BlockingCall waits for that thread to drain the queue. The reader
      // thread would stall, the pipe would fill, and core's own writes would
      // then block: a deadlock that takes the UI with it. Dropping a chunk
      // under pressure is the right trade for a log view.
      std::string chunk(buffer, static_cast<size_t>(n));
      tsfn.NonBlockingCall([chunk](Napi::Env cb_env, Napi::Function cb) {
        cb.Call({Napi::String::New(cb_env, chunk)});
      });
    }
    tsfn.Release();
    close(read_fd);
  }).detach();

  g_capturing = true;
  return env.Undefined();
}

Napi::Object InitAddon(Napi::Env env, Napi::Object exports) {
  exports.Set("init", Napi::Function::New(env, Init));
  exports.Set("addModulesDir", Napi::Function::New(env, AddModulesDir));
  exports.Set("setPersistenceBasePath", Napi::Function::New(env, SetPersistenceBasePath));
  exports.Set("setModuleTransports", Napi::Function::New(env, SetModuleTransports));
  exports.Set("start", Napi::Function::New(env, Start));
  exports.Set("cleanup", Napi::Function::New(env, Cleanup));

  exports.Set("loadModule", Napi::Function::New(env, LoadModule));
  exports.Set("unloadModule", Napi::Function::New(env, UnloadModule));
  exports.Set("knownModules", Napi::Function::New(env, KnownModules));
  exports.Set("loadedModules", Napi::Function::New(env, LoadedModules));
  exports.Set("modulesInfoJson", Napi::Function::New(env, ModulesInfoJson));
  exports.Set("refreshModules", Napi::Function::New(env, RefreshModules));
  exports.Set("getToken", Napi::Function::New(env, GetToken));
  exports.Set("startLogCapture", Napi::Function::New(env, StartLogCapture));

  // 0.3.0: calling modules in-process, with no daemon and no gateway.
  exports.Set("callModule", Napi::Function::New(env, CallModule));
  exports.Set("watchModule", Napi::Function::New(env, WatchModule));
  exports.Set("tick", Napi::Function::New(env, Tick));

  // Mirrors LogosLoadDeps. The header pins these numbers and forbids
  // renumbering, so exposing them by value is safe.
  exports.Set("LOAD_MODULE_ONLY", Napi::Number::New(env, LOGOS_LOAD_MODULE_ONLY));
  exports.Set("LOAD_REQUIRED_DEPS", Napi::Number::New(env, LOGOS_LOAD_REQUIRED_DEPS));
  exports.Set("LOAD_REQUIRED_AND_OPTIONAL",
              Napi::Number::New(env, LOGOS_LOAD_REQUIRED_AND_OPTIONAL));
  return exports;
}

}  // namespace

NODE_API_MODULE(logos_addon, InitAddon)
