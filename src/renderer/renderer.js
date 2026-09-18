// Renderer: one button, one outcome. Drives window.logos (from preload.js).
// No native code and no Node APIs here — contextIsolation is on.
'use strict';

const els = {
  status: document.getElementById('status'),
  start: document.getElementById('start'),
  startNode: document.getElementById('startNode'),
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

els.start.addEventListener('click', async () => {
  els.start.disabled = true;
  // Bringing up delivery means starting Waku — seconds, not milliseconds, and
  // it blocks the main process throughout (see addon.cc). Say so, because the
  // window is genuinely frozen until it returns.
  setStatus('Starting runtime and loading delivery…', 'working');
  log('Starting Logos runtime…');

  try {
    const result = await window.logos.startDelivery();
    for (const line of result.log) log(line);
    // The main process was blocked for the whole bring-up, so core's queued
    // lines land in one burst around now. Force a scroll rather than relying on
    // a frame callback that may not have run during the freeze.
    els.log.scrollTop = els.log.scrollHeight;

    if (result.ok) {
      // "loaded", not "running": core reports that the module's plugin loaded
      // in its host process. No Waku node exists until "Start Waku node" calls
      // createNode — which is now a button rather than a limitation.
      setStatus(`delivery module loaded (${result.elapsedMs} ms)`, 'ok');
      log(`Loaded modules: ${result.loaded.join(', ')}`);
      log('Loaded means the plugin is up in its host process — no peers yet.');
      els.startNode.disabled = false;
    } else {
      setStatus('delivery failed to load', 'error');
      log('core refused the load — see the terminal for its log', true);
      els.start.disabled = false;
    }
  } catch (err) {
    setStatus('Failed', 'error');
    log(err.message, true);
    els.start.disabled = false;
  }
});

// THE PAYOFF BUTTON: createNode() + start(), a real Waku node in this process.
//
// The window stays responsive throughout, which is the point of callModule
// being an AsyncWorker — invokeRemoteMethod blocks with a 20s default timeout,
// and doing that on the main thread would freeze the UI for the duration.
els.startNode.addEventListener('click', async () => {
  els.startNode.disabled = true;
  setStatus('Starting Waku node…', 'working');
  log('createNode() then start()…');

  try {
    await window.logos.startNode();
    setStatus('Waku node running', 'ok');
    log('Node started. Connection events follow as peers come and go.');
  } catch (err) {
    setStatus('Node failed to start', 'error');
    log(err.message, true);
    els.startNode.disabled = false;
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
window.logos.status().then((status) => {
  if (status.addonLoaded) {
    log('Native addon loaded.');
  } else {
    setStatus('Native addon failed to load', 'error');
    log(status.error, true);
    els.start.disabled = true;
  }
});
