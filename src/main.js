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
const { Daemon } = require('./daemon.js');
const { Gateway } = require('./gateway.js');

// As installed by lgpm and named in the module's manifest.json. It declares
// liblogos_rln_module as a required dependency, which LOAD_REQUIRED_DEPS (the
// default in index.js) resolves and loads first.
const MODULE_NAME = 'delivery_module';

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
      // The gateway route's own pieces: the daemon binary, the .lgx packages it
      // installs into its store, and the protocol library koffi dlopens.
      logosctl: path.join(root, 'logosctl', 'bin', 'logosctl'),
      packageDir: path.join(root, 'packages'),
      protocolLib: path.join(root, 'lib', 'liblogos_protocol.so'),
      // Packaged only: the bundled daemon is the unwrapped binary, so the app
      // supplies the Qt plugin path its Nix wrapper used to set.
      qtPluginPath: path.join(root, 'qt-plugins'),
    };
  }
  const root = path.join(__dirname, '..');
  return {
    modulesDir: path.join(root, 'modules'),
    hostPath: path.join(root, 'liblogos', 'bin', 'logos_host'),
    logosctl: path.join(root, 'logosctl', 'bin', 'logosctl'),
    // In a checkout the .lgx directories sit at the top level (delivery-lgx and
    // friends), which is what `make modules` installs from.
    packageDir: root,
    protocolLib: path.join(root, 'liblogos', 'lib', 'liblogos_protocol.so'),
    // In a checkout logosctl is still the Nix wrapper, which sets this itself.
    qtPluginPath: null,
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

// The whole demo in one call: bring up core, load delivery, report.
//
// NOTE: this blocks the main process for the entire bring-up — see the
// threading comment in addon.cc. For delivery that means starting Waku, so the
// window is unresponsive for seconds. Deliberate: a PoC that hid this behind a
// worker thread would be demonstrating the worker, not the binding.
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

// THE 0.2.0 PATH: a daemon beside the app, and the module driven through its
// core_service gateway.
//
// This is deliberately NOT the addon. The addon (logos:startDelivery above)
// loads the module into THIS process and cannot call it; the daemon loads its
// own copy into its own process and can. Running both would bring the module up
// twice for no benefit, so the button drives this one and the addon stays as
// what 0.1.0 proved — see the README.
let daemon = null;
let gateway = null;
// The in-flight start, so a second caller joins it instead of starting a
// SECOND daemon. That is not a theoretical tidiness concern: `daemon start`
// stops the previous daemon and the new one REWRITES auto.json, so the first
// caller is left holding a rotated token — and a stale token does not error,
// it hangs forever. Observed exactly once, as a 60s timeout on getStatus, when
// a headless run and a button click overlapped.
let startInFlight = null;

handle('logos:startNode', () => {
  if (gateway) return Promise.resolve({ alreadyRunning: true });
  if (!startInFlight) {
    startInFlight = startNode().finally(() => {
      startInFlight = null;
    });
  }
  return startInFlight;
});

async function startNode() {
  const { logosctl, packageDir, protocolLib, qtPluginPath } = runtimePaths();
  if (!fs.existsSync(logosctl)) {
    throw new Error(`logosctl not found at ${logosctl}`);
  }
  // The daemon spawns logos_host per module exactly as core does, and finds it
  // the same way. Without this it comes up and every module load fails.
  configureEnvironment();

  // Its own session directory under userData: this must not collide with a
  // logosctl the user runs by hand, and it should disappear with the app.
  daemon = new Daemon({
    binary: logosctl,
    configDir: path.join(app.getPath('userData'), 'logosctl'),
    packageDir,
    qtPluginPath,
    log: broadcastLog,
  });

  const { corePort, capPort } = await daemon.start(MODULE_NAME);

  // AFTER the daemon booted, never cached from earlier: auto.json is rewritten
  // on every boot and a stale token hangs rather than failing.
  const token = daemon.token();
  if (!token) broadcastLog('no token in the daemon session — calls may hang');

  // Assigned to the module-level `gateway` only once the whole sequence has
  // succeeded. A half-built one left there would make the guard above report a
  // running node and block the retry that would actually fix it.
  const pending = new Gateway({ corePort, capPort, token, protocolLib, log: broadcastLog });
  let status;
  try {
    status = await pending.getStatus();
  } catch (err) {
    pending.destroy();
    daemon.stop();
    daemon = null;
    throw err;
  }
  gateway = pending;

  // Subscribe BEFORE starting the node: the daemon forwards only what it is
  // already watching, and the first connectionStateChanged arrives during
  // start(). Watching afterwards is how you miss it.
  const watched = await gateway.watchEvents(MODULE_NAME, (event, data) => {
    broadcastLog(`[event] ${event} ${JSON.stringify(data)}`);
    for (const win of logSubscribers) {
      if (!win.isDestroyed()) win.webContents.send('logos:event', { event, data });
    }
  });
  broadcastLog(`watching: ${watched.join(', ') || 'nothing'}`);

  await gateway.startNode(MODULE_NAME);

  return {
    modules: (status && status.modules ? status.modules : []).map((m) => m.name),
    watched,
  };
}

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

// THE DAEMON MUST NOT OUTLIVE THE APP. It is a detached child holding two TCP
// ports and a loaded Waku node; leaving it behind means the next run's
// `daemon start` refuses (one daemon per session dir) and the ports stay bound.
//
// will-quit, not window-all-closed: the latter does not fire when the app is
// quit directly, and this has to run on every exit path.
function shutdownGateway() {
  if (gateway) {
    try {
      gateway.destroy();
    } catch {
      // Going away regardless.
    }
    gateway = null;
  }
  if (daemon) {
    daemon.stop();
    daemon = null;
  }
}

app.on('will-quit', shutdownGateway);

app.on('window-all-closed', () => {
  shutdownGateway();
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
