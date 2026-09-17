// EXPERIMENT 2, inside Electron. The in-process call path with Chromium live.
//
//   make exp-call-electron
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow } = require('electron');

const MODULE = process.env.MODULE || 'delivery_module';
const METHOD = process.env.EXP_METHOD || 'getAvailableConfigs';
const ARGS = process.env.EXP_ARGS || '[]';

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
process.env.LOGOS_LOG_LEVEL = process.env.LOGOS_LOG_LEVEL || 'info';

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 400, height: 300 });
  win.loadURL('data:text/html,<h1>exp</h1>');

  const addon = require(path.join(__dirname, 'build', 'Release', 'exp_call.node'));
  const modulesDir = path.join(__dirname, '..', '..', 'modules');
  const persistDir = path.join(app.getPath('userData'), 'exp-call-instances');
  fs.mkdirSync(persistDir, { recursive: true });

  const pump = setInterval(() => addon.tick(), 5);
  const finish = (code, note) => {
    clearInterval(pump);
    console.log(note);
    app.exit(code);
  };

  try {
    addon.setup(modulesDir, persistDir, process.env.EXP_ORIGIN || 'core_service');
    const loaded = addon.loadModule(MODULE);
    console.log(`[exp-call] loadModule(${MODULE}) -> ${loaded}`);
    if (!loaded) return finish(1, '\nFAIL: module did not load');

    await new Promise((r) => setTimeout(r, 3000));

    const r = JSON.parse(addon.callModule(MODULE, METHOD, ARGS));
    console.log(`[exp-call] ok=${r.ok} code=${r.code}`);
    console.log(`[exp-call] value=${JSON.stringify(r.value).slice(0, 400)}`);

    // Chromium must still be responsive — an RPC that wedges the UI is no win.
    const alive = await win.webContents.executeJavaScript('1 + 1');
    console.log(`[exp-call] renderer executeJavaScript(1+1) -> ${alive}`);

    finish(
      r.ok && alive === 2 ? 0 : 2,
      r.ok && alive === 2
        ? '\nPASS: in-process module call inside Electron, Chromium responsive'
        : `\nFAIL: ok=${r.ok} chromium=${alive}`
    );
  } catch (err) {
    finish(2, `\nFAIL: ${err.message}`);
  }
});
