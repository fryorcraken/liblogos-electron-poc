// 0.3.0 inside Electron, headless: a real Waku node started in the main process
// with a live BrowserWindow, and Chromium still answering afterwards.
//
//   make verify-inproc
//
// `verify` proves the 0.1.0 claim (the addon loads a module inside Electron).
// This proves the 0.3.0 one, which is a different mechanism and can fail on its
// own: Qt's event loop has to be pumped from a libuv timer in the same process
// that Chromium is driving, and the whole question 0.1.0 avoided — whether Qt
// and Chromium can coexist when Qt actually needs its loop serviced — only
// arises here.
//
// CHROMIUM'S HEALTH IS CHECKED AFTER THE NODE STARTS, and not merely for "did
// not crash": the renderer is made to execute JavaScript and return a value. A
// node that worked by wedging the UI would not be a result worth having.
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow } = require('electron');

const modulesDir = path.join(__dirname, '..', 'modules');
const moduleName = process.env.MODULE || 'delivery_module';

// The same config src/main.js uses. A `preset` is what makes the node dial
// anybody; "{}" starts a node with nobody to talk to and emits nothing, which
// would make this test pass while observing silence.
const NODE_CONFIG = JSON.stringify({ mode: 'Core', preset: 'logos.test' });

// Long enough for the first connection events on a working network, short
// enough that CI is not waiting on it.
const WATCH_MS = Number(process.env.WATCH_MS || 20000);

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
process.env.LOGOS_LOG_LEVEL = process.env.LOGOS_LOG_LEVEL || 'debug';

const events = [];

app.whenReady().then(async () => {
  let failed = false;
  let win = null;
  try {
    // A REAL WINDOW, not a headless main process. Chromium's main-process
    // message loop is the thing Qt might collide with, and it is only fully in
    // play once there is something to render.
    win = new BrowserWindow({ width: 600, height: 400, show: false });
    await win.loadURL('data:text/html,<h1>inproc smoke</h1>');

    const core = require('../src/index.js');
    console.log('addon loaded inside Electron main process');

    core.init();
    core.addModulesDir(modulesDir);
    const persistenceDir = path.join(app.getPath('userData'), 'module-instances');
    fs.mkdirSync(persistenceDir, { recursive: true });
    core.setPersistenceBasePath(persistenceDir);
    core.start();
    console.log(`known: ${core.knownModules().join(', ')}`);

    const loaded = core.loadModule(moduleName);
    console.log(`loadModule(${moduleName}) -> ${loaded}`);
    if (!loaded) throw new Error(`${moduleName} did not load`);

    // Wildcard subscription, taken before createNode — the module wires its
    // event callback only once createNode succeeds.
    const subscriptionId = core.watchModule(moduleName, '', (event, args) => {
      events.push(event);
      console.log(`  EVENT ${event}: ${JSON.stringify(args).slice(0, 200)}`);
    });
    console.log(`watchModule(${moduleName}, *) -> id=${subscriptionId}`);
    if (subscriptionId === 0) throw new Error('subscription refused');

    console.log(`createNode(${NODE_CONFIG})`);
    const created = await core.callModule(moduleName, 'createNode', [NODE_CONFIG]);
    console.log(`  -> ${JSON.stringify(created)}`);
    if (created && created.success === false) {
      throw new Error(`createNode refused: ${created.error || 'no reason given'}`);
    }

    const started = await core.callModule(moduleName, 'start', []);
    console.log(`start() -> ${JSON.stringify(started)}`);
    if (started && started.success === false) {
      throw new Error(`start refused: ${started.error || 'no reason given'}`);
    }

    console.log(`watching for events for ${WATCH_MS} ms…`);
    await new Promise((resolve) => setTimeout(resolve, WATCH_MS));

    // CHROMIUM STILL ALIVE? Executing JS in the renderer and getting a value
    // back is the check — a node that ran by starving the UI would fail here
    // and pass every other assertion.
    const answer = await win.webContents.executeJavaScript('1+1');
    console.log(`renderer executeJavaScript(1+1) -> ${answer}`);
    const chromiumOk = answer === 2;

    console.log(`\nevents: ${events.length} (${[...new Set(events)].join(', ') || 'none'})`);
    core.cleanup();

    if (events.length === 0) {
      console.error('FAILED: node started but emitted nothing — no evidence it is on a network');
      failed = true;
    } else if (!chromiumOk) {
      console.error('FAILED: the node ran but Chromium stopped answering');
      failed = true;
    } else {
      console.log('\nPASS: a Waku node started in-process inside Electron, Chromium responsive');
    }
  } catch (err) {
    console.error(`FAILED: ${err.message}`);
    failed = true;
  }
  if (win !== null && !win.isDestroyed()) win.destroy();
  app.exit(failed ? 1 : 0);
});
