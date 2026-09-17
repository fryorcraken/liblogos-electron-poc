// Thin JS layer over the native addon.
//
// The addon deliberately stays close to the C ABI; the ergonomics live here:
// a legible error when the .node is missing, and JSON parsing for the one
// accessor that returns a JSON string.
'use strict';

const path = require('node:path');

function loadAddon() {
  // In a packaged app __dirname points INSIDE app.asar, but dlopen cannot read
  // from an asar archive — which is why electron-builder's asarUnpack copies the
  // addon out to app.asar.unpacked. Rewriting the path is the documented way to
  // reach it; the unpacked tree mirrors the archive exactly.
  const addonPath = path
    .join(__dirname, '..', 'build', 'Release', 'logos_addon.node')
    .replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  try {
    return require(addonPath);
  } catch (err) {
    // The two failure modes look nothing alike and have different fixes, so
    // they get different messages rather than one generic "could not load".
    if (err.code === 'MODULE_NOT_FOUND') {
      throw new Error(
        `liblogos addon not built (${addonPath}).\n` +
          "Build it inside liblogos' dev shell:\n" +
          "  nix develop 'github:logos-co/logos-liblogos' -c \\\n" +
          '    env LOGOS_LIBLOGOS_ROOT="$PWD/liblogos" npm run build'
      );
    }
    // A dlopen failure — a missing libQt6Core.so.6 or liblogos_core.so — arrives
    // here. It means the addon built but cannot resolve its shared libraries,
    // which is an rpath/dev-shell problem, not a build one.
    throw new Error(
      `liblogos addon failed to load: ${err.message}\n` +
        "This is usually a missing Qt or liblogos runtime. Run inside liblogos' dev shell:\n" +
        "  nix develop 'github:logos-co/logos-liblogos' -c npm start"
    );
  }
}

const addon = loadAddon();

// THE QT EVENT LOOP PUMP.
//
// A QtRO round trip completes only when Qt's event loop is serviced, and this
// addon has never run one — 0.1.0 did not need it, because liblogos' load calls
// are synchronous. Calling a module is not.
//
// The interval lives in JS rather than C++ because a libuv timer is what makes
// it cooperative: it yields to everything else on the loop between ticks, where
// a C++ thread running QEventLoop::exec() would not — and, measurably, would not
// work at all (the Qt objects are affined to the thread that created them; see
// addon.cc's Tick).
//
// 5 ms IS NOT A MEASURED NUMBER. docs/0.3.0-inventory.md §5.4 is explicit that
// nothing here characterises latency or CPU against it, and that a timer firing
// 200 times a second in an idle app is a battery question nobody has asked.
const PUMP_INTERVAL_MS = 5;
let pumpTimer = null;

function startPump() {
  if (pumpTimer !== null) return;
  pumpTimer = setInterval(addon.tick, PUMP_INTERVAL_MS);
  // Do not hold the process open on the pump's account. Without this a plain
  // Node script that finished its work would never exit, because an interval is
  // a live handle — and `make smoke` would hang instead of reporting.
  if (typeof pumpTimer.unref === 'function') pumpTimer.unref();
}

function stopPump() {
  if (pumpTimer === null) return;
  clearInterval(pumpTimer);
  pumpTimer = null;
}

module.exports = {
  init: addon.init,
  addModulesDir: addon.addModulesDir,
  setPersistenceBasePath: addon.setPersistenceBasePath,

  /**
   * Give a module its own transport set, so a consumer outside this process can
   * reach it. `transportSetJson` is a JSON array of LogosTransportConfig; see
   * logos_transport_config.h. Must be called before the module loads.
   */
  setModuleTransports: addon.setModuleTransports,

  /**
   * A capability token from core's token manager, or null if the key is
   * unknown. An out-of-process consumer needs one to call a module over a plain
   * transport, where the capability handshake is not available.
   */
  getToken: addon.getToken,

  /**
   * Bring the runtime up and start pumping Qt's event loop.
   *
   * The pump starts HERE rather than being left to the caller because nothing
   * below start() works without it and the failure mode is silent: an unpumped
   * callModule() does not error, it waits out its 20s timeout. Making it
   * impossible to forget is worth more than the flexibility of a separate call.
   */
  start(...args) {
    addon.start(...args);
    startPump();
  },

  /** Stop the pump, drain, and tear the runtime down. */
  cleanup(...args) {
    stopPump();
    addon.cleanup(...args);
  },

  loadModule: addon.loadModule,
  unloadModule: addon.unloadModule,
  knownModules: addon.knownModules,
  loadedModules: addon.loadedModules,
  refreshModules: addon.refreshModules,

  /**
   * Redirect fds 1 and 2 into a pipe and invoke `onChunk(text)` for everything
   * written there — the only way to see spdlog output, which never passes
   * through Node. Output is still echoed to the real stdout. Idempotent.
   */
  startLogCapture: addon.startLogCapture,

  /**
   * Call a method on a loaded module, in-process. Resolves with the module's
   * own parsed answer; rejects if the CALL failed.
   *
   * Those are different things and the distinction is the point. A rejection
   * means the invocation did not reach the module (logos::CallError — a bad
   * module name, an object that never became available). A resolved value may
   * still be the module REFUSING, as `{success: false, error: "..."}` — which is
   * the module talking, and a legitimate outcome. Folding the two together
   * would make "the module said no" indistinguishable from "nothing answered".
   *
   * Async because invokeRemoteMethod blocks with a 20s default timeout; on
   * Electron's main thread a synchronous version freezes the UI for as long as
   * the module takes.
   */
  async callModule(moduleName, methodName, args = []) {
    if (!Array.isArray(args)) throw new TypeError('args must be an array');
    const json = await addon.callModule(moduleName, methodName, JSON.stringify(args));
    try {
      return JSON.parse(json);
    } catch (err) {
      throw new Error(`${moduleName}.${methodName} returned malformed JSON: ${err.message}`);
    }
  },

  /**
   * Subscribe to a module's events. `callback(eventName, args)` fires for each.
   *
   * An empty (or omitted) `eventName` means EVERY event on that module, which
   * is what a log view wants. It is also the only spelling that cannot be wrong:
   * the subscription arms on names the module never emits, so a typo looks
   * exactly like a module that is simply quiet.
   *
   * Returns the non-zero subscription id, or 0 if the arguments were refused.
   * There is no unsubscribe here on purpose — the underlying
   * cancelEventSubscription() stops the bookkeeping but does not detach the
   * callback, so offering one would promise more than it delivers.
   */
  watchModule(moduleName, eventName, callback) {
    if (typeof eventName === 'function') {
      callback = eventName;
      eventName = '';
    }
    return addon.watchModule(moduleName, eventName || '', (json) => {
      let message;
      try {
        message = JSON.parse(json);
      } catch {
        return; // A malformed event is not worth taking the app down for.
      }
      callback(message.event, message.args || []);
    });
  },

  /** Parsed form of logos_core_get_modules_info(). See logos_core.h for the shape. */
  modulesInfo() {
    const json = addon.modulesInfoJson();
    if (json == null) return [];
    try {
      return JSON.parse(json);
    } catch (err) {
      throw new Error(`core returned malformed modules JSON: ${err.message}`);
    }
  },

  LOAD_MODULE_ONLY: addon.LOAD_MODULE_ONLY,
  LOAD_REQUIRED_DEPS: addon.LOAD_REQUIRED_DEPS,
  LOAD_REQUIRED_AND_OPTIONAL: addon.LOAD_REQUIRED_AND_OPTIONAL,
};
