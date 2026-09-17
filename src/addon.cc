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

#include <cstdlib>
#include <string>
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

// Consume a null-terminated char** from core into a JS array, freeing as it goes.
Napi::Array TakeStringArray(const Napi::Env& env, char** owned) {
  Napi::Array out = Napi::Array::New(env);
  if (owned == nullptr) {
    return out;
  }
  uint32_t i = 0;
  for (char** cursor = owned; *cursor != nullptr; ++cursor, ++i) {
    out.Set(i, Napi::String::New(env, *cursor));
    std::free(*cursor);
  }
  std::free(owned);
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
  std::free(owned);
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

Napi::Value RefreshModules(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  RequireState(env, g_initialized, "call init() before refreshModules()");
  logos_core_refresh_modules();
  return env.Undefined();
}

Napi::Object InitAddon(Napi::Env env, Napi::Object exports) {
  exports.Set("init", Napi::Function::New(env, Init));
  exports.Set("addModulesDir", Napi::Function::New(env, AddModulesDir));
  exports.Set("start", Napi::Function::New(env, Start));
  exports.Set("cleanup", Napi::Function::New(env, Cleanup));

  exports.Set("loadModule", Napi::Function::New(env, LoadModule));
  exports.Set("unloadModule", Napi::Function::New(env, UnloadModule));
  exports.Set("knownModules", Napi::Function::New(env, KnownModules));
  exports.Set("loadedModules", Napi::Function::New(env, LoadedModules));
  exports.Set("modulesInfoJson", Napi::Function::New(env, ModulesInfoJson));
  exports.Set("refreshModules", Napi::Function::New(env, RefreshModules));

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
