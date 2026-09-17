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

#include <unistd.h>

#include <cstdlib>
#include <string>
#include <thread>
#include <vector>

extern "C" {
#include "logos_core.h"
}

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
  }
  return env.Undefined();
}

Napi::Value Cleanup(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (g_started || g_initialized) {
    logos_core_cleanup();
    g_started = false;
    g_initialized = false;
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
