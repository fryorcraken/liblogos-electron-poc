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

app.whenReady().then(() => {
  let failed = false;
  try {
    const core = require('../src/index.js');
    console.log('addon loaded inside Electron main process');

    core.init();
    core.addModulesDir(modulesDir);
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
