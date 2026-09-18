// Renderer: one button, one outcome. Drives window.logos (from preload.js).
// No native code and no Node APIs here — contextIsolation is on.
'use strict';

const els = {
  status: document.getElementById('status'),
  loadOnly: document.getElementById('loadOnly'),
  viaLogosctl: document.getElementById('viaLogosctl'),
  viaInProcess: document.getElementById('viaInProcess'),
  log: document.getElementById('log'),
};

function setStatus(text, state) {
  els.status.textContent = text;
  els.status.dataset.state = state;
}

// Autoscroll, but only while the view is already at the bottom — so scrolling
// up to read something is not yanked back by the next line. A few pixels of
// slack absorbs sub-pixel rounding at fractional zoom levels.
function isPinnedToBottom() {
  const { scrollTop, scrollHeight, clientHeight } = els.log;
  return scrollHeight - scrollTop - clientHeight < 40;
}

// Scrolling is deferred to the next frame: lines arrive in bursts (80+ during a
// module bring-up), and setting scrollTop per line makes the browser measure
// layout each time, which both janks and lags behind the last append.
let scrollQueued = false;
function scrollToBottom() {
  if (scrollQueued) return;
  scrollQueued = true;
  requestAnimationFrame(() => {
    scrollQueued = false;
    els.log.scrollTop = els.log.scrollHeight;
  });
}

function appendLine(node) {
  const pinned = isPinnedToBottom();
  els.log.append(node);
  if (pinned) scrollToBottom();
}

function log(message, isError = false) {
  const line = document.createElement('div');
  if (isError) line.className = 'err';
  line.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  appendLine(line);
}

// The three routes are mutually exclusive: each brings delivery_module up, and
// two at once contend for the same ports and persistence directory. Main
// refuses the second one, but disabling the buttons says so before the click.
function lockButtons() {
  els.loadOnly.disabled = true;
  els.viaLogosctl.disabled = true;
  els.viaInProcess.disabled = true;
}

function unlockButtons() {
  els.loadOnly.disabled = false;
  els.viaLogosctl.disabled = false;
  els.viaInProcess.disabled = false;
}

// 0.1.0 — the C ABI. Loads the module into THIS process and stops: nothing in
// logos_core.h can call a module, which is the whole reason the other two
// buttons exist.
els.loadOnly.addEventListener('click', async () => {
  lockButtons();
  // loadModule blocks the main process for the whole bring-up (see addon.cc),
  // so the window is genuinely frozen until it returns. Say so.
  setStatus('Loading delivery_module through the C ABI…', 'working');
  log('logos_core_init → add_modules_dir → start → load_module');

  try {
    const result = await window.logos.loadOnly();
    for (const line of result.log) log(line);
    // The main process was blocked throughout, so core's queued lines land in
    // one burst around now. Force a scroll rather than relying on a frame
    // callback that may not have run during the freeze.
    els.log.scrollTop = els.log.scrollHeight;

    if (result.ok) {
      setStatus(`loaded in ${result.elapsedMs} ms — not running`, 'ok');
      log(`Loaded modules: ${result.loaded.join(', ')}`);
      log('Loaded means the plugin is up in its host process. No node, no peers.');
    } else {
      setStatus('delivery_module failed to load', 'error');
      log('core refused the load — see the log above', true);
      unlockButtons();
    }
  } catch (err) {
    setStatus('Failed', 'error');
    log(err.message, true);
    unlockButtons();
  }
});

// 0.2.0 — a logosctl daemon beside the app, driven over its core_service
// gateway with the Qt-free JS SDK. A cold first run installs four packages into
// the daemon's store, so this takes minutes, not seconds.
els.viaLogosctl.addEventListener('click', async () => {
  lockButtons();
  setStatus('Starting the logosctl daemon…', 'working');
  log('Spawning logosctl, loading the module into it, then createNode + start…');

  try {
    const result = await window.logos.startViaLogosctl();
    setStatus('Waku node running (via logosctl)', 'ok');
    if (result.modules) log(`Daemon modules: ${result.modules.join(', ')}`);
    if (result.watched) log(`Subscribed to: ${result.watched.join(', ')}`);
    log('The node is up. Connection events arrive as peers come and go.');
  } catch (err) {
    setStatus('Failed to start via logosctl', 'error');
    log(err.message, true);
    unlockButtons();
  }
});

// 0.3.0 — the addon calls the module itself. No daemon, no gateway, no
// transport.
//
// The window stays responsive throughout, which is the point of callModule
// being an AsyncWorker: invokeRemoteMethod blocks with a 20s default timeout,
// and doing that on the main thread would freeze the UI for the duration.
els.viaInProcess.addEventListener('click', async () => {
  lockButtons();
  setStatus('Starting a Waku node in-process…', 'working');
  log('watchModule → createNode() → start(), all in this process');

  try {
    await window.logos.startViaInProcess();
    setStatus('Waku node running (in-process)', 'ok');
    log('Node started with no daemon. Connection events follow.');
  } catch (err) {
    setStatus('Node failed to start', 'error');
    log(err.message, true);
    unlockButtons();
  }
});

// Core's own log, streamed from the native side. These are the module's real
// messages — spdlog output from core and from each module host — not this
// renderer's commentary, so they are marked to tell them apart.
window.logos.onLog((line) => {
  const el = document.createElement('div');
  el.className = 'native';
  el.textContent = line;
  appendLine(el);
});

// MODULE EVENTS: the node itself, not a log line about it. These are what the
// log pane was missing — connectionStateChanged as peers come and go is the
// continuous activity that makes a running node visible.
window.logos.onModuleEvent((event, args) => {
  const el = document.createElement('div');
  el.className = 'event';
  el.textContent = `[${new Date().toLocaleTimeString()}] ${event}: ${JSON.stringify(args)}`;
  appendLine(el);
});

// Surface a broken addon immediately rather than on first click.
//
// Only two of the three routes need it: loadOnly and startViaInProcess both go
// through the addon, while startViaLogosctl drives a separate process and works
// even when the addon does not — which is worth saying rather than disabling
// every button.
window.logos.status().then((status) => {
  if (status.addonLoaded) {
    log('Native addon loaded.');
  } else {
    setStatus('Native addon failed to load', 'error');
    log(status.error, true);
    log('The logosctl route does not need it; the other two do.');
    els.loadOnly.disabled = true;
    els.viaInProcess.disabled = true;
  }
});
