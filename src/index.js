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
  start: addon.start,
  cleanup: addon.cleanup,

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
