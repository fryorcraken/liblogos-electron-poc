// Electron main process: owns the liblogos runtime, exposes it to the renderer
// over IPC.
//
// The addon is loaded HERE and nowhere else. The renderer never sees native
// code — it gets a fixed set of IPC channels through preload.js, with
// contextIsolation on and nodeIntegration off. That is both Electron's security
// default and the honest shape for this: liblogos is a process-wide singleton
// with a thread affinity, so exactly one place may drive it.
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, ipcMain } = require('electron');

// As installed by lgpm and named in the module's manifest.json. It declares
// liblogos_rln_module as a required dependency, which LOAD_REQUIRED_DEPS (the
// default in index.js) resolves and loads first.
const MODULE_NAME = 'delivery_module';

// THE NODE CONFIG, and why this one.
//
// createNode takes a flat JSON object of WakuNodeConf fields, not a config name
// — passing a name answers "createNode cfg is not valid JSON". Unknown keys are
// ignored and every field has a default, so "{}" is accepted; it is the wrong
// choice, because with no entry nodes there is nobody to dial and the node sits
// silent. That is the "log goes quiet after bring-up" problem this release
// exists to fix, wearing a different hat.
//
// A `preset` populates cluster id, entry nodes and sharding together, and its
// bootstrap nodes are where the connection traffic comes from. Valid names are
// "", "twn", "logos.dev", "logos.test" and "status.prod". "twn" is the
// RLN-protected Waku Network and would additionally need a registered
// membership, which this PoC does not have.
//
// Only mode/preset at the top level, deliberately: any OTHER bare top-level key
// (logLevel is the easy one to reach for) silently selects the backend's legacy
// flat WakuNodeConf shape instead of this one. Both parse; they are different
// code paths.
const NODE_CONFIG = JSON.stringify({ mode: 'Core', preset: 'logos.test' });

// WHERE THE RUNTIME LIVES, which differs between a checkout and a packaged app.
//
//   packaged   resources/runtime/{modules,lib,bin} inside the AppImage
//   checkout   ./modules and ./liblogos/bin next to the source
//
// app.isPackaged is the only reliable discriminator; __dirname is inside the
// asar archive when packaged and tells us nothing about the unpacked resources.
function runtimePaths() {
  if (app.isPackaged) {
    const root = path.join(process.resourcesPath, 'runtime');
    return {
      modulesDir: path.join(root, 'modules'),
      hostPath: path.join(root, 'bin', 'logos_host'),
    };
  }
  const root = path.join(__dirname, '..');
  return {
    modulesDir: path.join(root, 'modules'),
    hostPath: path.join(root, 'liblogos', 'bin', 'logos_host'),
  };
}

// Core spawns logos_host per module and finds it through the environment, so it
// must be set before start(). In a packaged app nothing else will have set it.
function configureEnvironment() {
  const { hostPath } = runtimePaths();
  if (fs.existsSync(hostPath)) {
    process.env.LOGOS_HOST_PATH = hostPath;
  }

  // Core reads this at startup and passes it to the module hosts. Default to
  // debug so the UI shows what the modules are actually doing — at the default
  // level most of a module's own lifecycle is invisible.
  if (!process.env.LOGOS_LOG_LEVEL) {
    process.env.LOGOS_LOG_LEVEL = 'debug';
  }

  // Each module instance gets its own subdirectory here. Without it the RLN
  // membership module warns that "keystore ops will fail" — it has nowhere to
  // put a keystore.
  const persistenceDir = path.join(app.getPath('userData'), 'module-instances');
  fs.mkdirSync(persistenceDir, { recursive: true });

  return { hostPath, persistenceDir };
}

// CAPTURING CORE'S LOG.
//
// liblogos and the module hosts write to the process's stdout/stderr file
// descriptors from C++, so nothing in JS sees them — in a packaged app they go
// nowhere the user can read. Patching process.stdout.write is not enough for
// the same reason: the writes never pass through Node.
//
// So the fds themselves are redirected into a pipe, which is then read back in
// JS and forwarded to the renderer (and still echoed to the real stdout, so
// `make verify` and CI keep their output).
const logSubscribers = new Set();

function broadcastLog(text) {
  for (const line of text.split('\n')) {
    const trimmed = line.trimEnd();
    if (trimmed === '') continue;
    for (const win of logSubscribers) {
      if (!win.isDestroyed()) win.webContents.send('logos:log', trimmed);
    }
  }
}

// Module events, on their own channel rather than folded into the log stream.
// They are structured — a name and a payload — and the renderer marks them
// differently, because "the node told us something" and "spdlog wrote a line"
// are not the same kind of evidence.
function broadcastModuleEvent(event, args) {
  for (const win of logSubscribers) {
    if (!win.isDestroyed()) win.webContents.send('logos:moduleEvent', { event, args });
  }
}

// Starts the addon's fd-level capture and pumps what it reads to the renderer.
// The redirect itself lives in C++ (see captureOutput in addon.cc) because
// spdlog writes to the file descriptor, never through Node.
function captureNativeOutput() {
  const core = getRuntime();
  core.startLogCapture((text) => broadcastLog(text));
}

// Lazily required so a build or link failure surfaces in the UI as a message
// rather than killing the process before a window ever appears.
let liblogos = null;
let loadError = null;

function getRuntime() {
  if (liblogos === null && loadError === null) {
    try {
      liblogos = require('./index.js');
    } catch (err) {
      loadError = err;
    }
  }
  if (loadError !== null) throw loadError;
  return liblogos;
}

// Handlers return {ok, value} / {ok, error} rather than letting rejections cross
// the IPC boundary: Electron wraps thrown errors in a way that buries the
// message, and this PoC is largely about reading failure messages.
function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, value: await fn(...args) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
}

handle('logos:status', () => {
  try {
    getRuntime();
    return { addonLoaded: true };
  } catch (err) {
    return { addonLoaded: false, error: err.message };
  }
});

// Bring up core and load delivery.
//
// NOTE: loadModule blocks the main process for the whole bring-up — see the
// threading comment in addon.cc. Deliberate: a PoC that hid this behind a worker
// thread would be demonstrating the worker, not the binding. The node start
// below is the part that had to stop blocking, and it does.
handle('logos:startDelivery', () => {
  const core = getRuntime();
  const { modulesDir } = runtimePaths();
  const { hostPath, persistenceDir } = configureEnvironment();
  const log = [];

  if (!fs.existsSync(modulesDir)) {
    throw new Error(`modules directory not found: ${modulesDir}`);
  }
  log.push(`modules dir: ${modulesDir}`);
  log.push(`logos_host: ${hostPath}`);
  log.push(`persistence: ${persistenceDir}`);
  log.push(`log level: ${process.env.LOGOS_LOG_LEVEL}`);

  const started = Date.now();
  core.init();
  core.addModulesDir(modulesDir);
  core.setPersistenceBasePath(persistenceDir);
  core.start();
  log.push(`runtime started · known: ${core.knownModules().join(', ')}`);

  const ok = core.loadModule(MODULE_NAME);
  const elapsedMs = Date.now() - started;
  log.push(`loadModule(${MODULE_NAME}) -> ${ok} in ${elapsedMs} ms`);

  return { ok, elapsedMs, log, loaded: core.loadedModules() };
});

// THE 0.3.0 PAYOFF: a real Waku node, started from the Electron app, with no
// daemon beside it and no gateway in between.
//
// 0.2.0 reached this point by spawning a logosctl daemon and talking to its
// core_service over loopback TCP. This calls the module directly over the
// default LocalSocket/QtRO transport that every module already publishes on —
// which the addon can speak because it is a Qt participant in the same process,
// and which the JS SDK could not, because it is not.
let nodeStarted = false;

handle('logos:startNode', async () => {
  const core = getRuntime();
  if (nodeStarted) throw new Error('the node is already running');

  const log = [];
  const say = (line) => {
    log.push(line);
    broadcastLog(line);
  };

  // SUBSCRIBE FIRST, and with the wildcard.
  //
  // Before createNode because the module wires its own event callback only on
  // createNode's success path, so a subscription taken afterwards can miss the
  // first connectionStateChanged. The empty event name means every event on the
  // module: it is what this log pane wants, and it is the only spelling that
  // cannot be silently wrong, since a subscription arms happily on names the
  // module never emits.
  const subscriptionId = core.watchModule(MODULE_NAME, '', broadcastModuleEvent);
  say(`watchModule(${MODULE_NAME}, *) -> id=${subscriptionId}`);
  if (subscriptionId === 0) throw new Error('the event subscription was refused');

  // createNode then start, the module's documented order (createNode exactly
  // once per context; start before any message operation). Both are awaited
  // rather than blocking: invokeRemoteMethod has a 20s default timeout and this
  // is the main process.
  say(`createNode(${NODE_CONFIG})`);
  const created = await core.callModule(MODULE_NAME, 'createNode', [NODE_CONFIG]);
  say(`  -> ${JSON.stringify(created)}`);
  if (created && created.success === false) {
    throw new Error(`createNode refused: ${created.error || 'no reason given'}`);
  }

  say('start() — bringing the Waku node up');
  const started = await core.callModule(MODULE_NAME, 'start', []);
  say(`  -> ${JSON.stringify(started)}`);
  if (started && started.success === false) {
    throw new Error(`start refused: ${started.error || 'no reason given'}`);
  }

  nodeStarted = true;
  return { ok: true, subscriptionId };
});

function createWindow() {
  const win = new BrowserWindow({
    width: 760,
    height: 620,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => logSubscribers.delete(win));

  // WAIT FOR THE RENDERER. loadFile is asynchronous, and webContents.send drops
  // anything sent before the page is ready — so starting the capture here would
  // redirect stdout into a pipe whose output goes nowhere, losing the terminal
  // copy as well. did-finish-load is the first point at which the page can
  // actually receive.
  win.webContents.once('did-finish-load', () => {
    logSubscribers.add(win);
    try {
      captureNativeOutput();
    } catch (err) {
      // The redirect failed, so this still reaches the real stdout.
      console.error(`log capture unavailable: ${err.message}`);
    }
  });
}

// Headless self-test: bring up delivery, print the result, exit with a status.
// This is how CI checks the PACKAGED AppImage — the same code path the button
// drives, minus the window and the human.
async function runSmokeTest() {
  try {
    const core = getRuntime();
    const { modulesDir } = runtimePaths();
    const { hostPath, persistenceDir } = configureEnvironment();
    console.log(`modules dir: ${modulesDir}`);
    console.log(`logos_host:  ${hostPath}`);

    const started = Date.now();
    core.init();
    core.addModulesDir(modulesDir);
    core.setPersistenceBasePath(persistenceDir);
    core.start();
    console.log(`known: ${core.knownModules().join(', ')}`);

    const ok = core.loadModule(MODULE_NAME);
    console.log(`loadModule(${MODULE_NAME}) -> ${ok} in ${Date.now() - started} ms`);
    console.log(`loaded: ${core.loadedModules().join(', ')}`);
    core.cleanup();

    console.log(ok ? `\nPASS: ${MODULE_NAME} loaded from the packaged app` : '\nFAIL');
    app.exit(ok ? 0 : 1);
  } catch (err) {
    console.error(`FAIL: ${err.message}`);
    app.exit(1);
  }
}

app.whenReady().then(() => {
  if (process.env.LOGOS_SMOKE === '1') return runSmokeTest();
  return createWindow();
});

app.on('window-all-closed', () => {
  // Bring the runtime down while the Qt application object is still alive.
  if (liblogos !== null) {
    try {
      liblogos.cleanup();
    } catch {
      // Nothing useful to do during teardown; the process is going away.
    }
  }
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
