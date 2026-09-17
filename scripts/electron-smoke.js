// The smoke test, run INSIDE Electron's main process, with no window and no
// clicking.
//
// This is the question the PoC exists to answer. scripts/smoke.js proves the
// binding works under plain Node; this proves it still works once Chromium is
// in the same process — competing event loops, a second set of symbols, and
// Electron's own Node ABI. Run with:  make verify
'use strict';

const path = require('node:path');
const { app } = require('electron');

const modulesDir = path.join(__dirname, '..', 'modules');
const moduleName = process.argv[2] || 'test_basic_module';

app.disableHardwareAcceleration();

// Chromium's SUID sandbox helper must be root-owned mode 4755, which it is not
// in a node_modules checkout on a CI runner — it aborts with "The SUID sandbox
// helper binary was found, but is not configured correctly" before anything
// runs. Disabled here rather than on the command line so it applies however
// this script is invoked. Headless check, local files only.
app.commandLine.appendSwitch('no-sandbox');

// Core reads this at startup and passes it to the module hosts.
process.env.LOGOS_LOG_LEVEL = process.env.LOGOS_LOG_LEVEL || 'debug';

app.whenReady().then(() => {
  let failed = false;
  try {
    const core = require('../src/index.js');
    console.log('addon loaded inside Electron main process');

    core.init();
    core.addModulesDir(modulesDir);
    // Without this the RLN membership module warns that keystore ops will fail.
    const persistenceDir = path.join(app.getPath('userData'), 'module-instances');
    require('node:fs').mkdirSync(persistenceDir, { recursive: true });
    core.setPersistenceBasePath(persistenceDir);
    core.start();
    console.log('runtime started');
    console.log(`known: ${core.knownModules().join(', ')}`);

    const ok = core.loadModule(moduleName);
    console.log(`loadModule(${moduleName}) -> ${ok}`);
    console.log(`loaded: ${core.loadedModules().join(', ')}`);

    const info = core.modulesInfo();
    console.log(`modulesInfo(): ${info.map((m) => `${m.name}=${m.loaded}`).join(', ')}`);

    core.cleanup();
    console.log('cleanup ok');

    if (!ok) {
      console.error(`FAILED: ${moduleName} did not load`);
      failed = true;
    } else {
      console.log(`\nPASS: ${moduleName} loaded through liblogos inside Electron`);
    }
  } catch (err) {
    console.error(`FAILED: ${err.message}`);
    failed = true;
  }
  app.exit(failed ? 1 : 0);
});
