// Renderer: one button, one outcome. Drives window.logos (from preload.js).
// No native code and no Node APIs here — contextIsolation is on.
'use strict';

const els = {
  status: document.getElementById('status'),
  start: document.getElementById('start'),
  load: document.getElementById('load'),
  log: document.getElementById('log'),
  conn: document.getElementById('conn'),
  connState: document.getElementById('connState'),
  eventCount: document.getElementById('eventCount'),
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

// THE 0.2.0 BUTTON: daemon up, module loaded in it, real Waku node started.
els.start.addEventListener('click', async () => {
  els.start.disabled = true;
  els.load.disabled = true;
  els.conn.hidden = false;
  // Minutes, not seconds, on a cold run: the daemon installs four packages into
  // its store before it can load anything. Say so rather than looking hung.
  setStatus('Starting daemon and bringing a node up…', 'working');
  log('Starting the logosctl daemon…');

  try {
    const result = await window.logos.startNode();
    setStatus('Waku node running — watching for events', 'ok');
    log(`Daemon modules: ${result.modules.join(', ')}`);
    log(`Subscribed to: ${result.watched.join(', ')}`);
    log('The node is up. Connection events arrive as peers come and go.');
  } catch (err) {
    setStatus('Failed to start the node', 'error');
    log(err.message, true);
    els.start.disabled = false;
    els.load.disabled = false;
  }
});

// The module's own events, as forwarded by the daemon. connectionStateChanged
// carries [status, timestamp] — the status is what the header shows.
let eventCount = 0;
window.logos.onEvent(({ event, data }) => {
  eventCount += 1;
  els.eventCount.textContent = String(eventCount);
  if (event === 'connectionStateChanged' && data.length > 0) {
    els.connState.textContent = String(data[0]);
    els.connState.dataset.state = String(data[0]);
  }
});

// The 0.1.0 path, kept: load the module through the addon's C ABI in THIS
// process. It proves the packaging, and cannot call the module — which is the
// gap the button above closes.
els.load.addEventListener('click', async () => {
  els.start.disabled = true;
  els.load.disabled = true;
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
      // in its host process. Nothing here calls the module's own API, so no
      // Waku node is started and no peers are connected. See the README.
      setStatus(`delivery module loaded (${result.elapsedMs} ms)`, 'ok');
      log(`Loaded modules: ${result.loaded.join(', ')}`);
      log('Note: loaded means the plugin is up in its host process — no peers or traffic.');
    } else {
      setStatus('delivery failed to load', 'error');
      log('core refused the load — see the terminal for its log', true);
      els.start.disabled = false;
      els.load.disabled = false;
    }
  } catch (err) {
    setStatus('Failed', 'error');
    log(err.message, true);
    els.start.disabled = false;
    els.load.disabled = false;
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

// Surface a broken addon immediately rather than on first click. Only the
// 0.1.0 button is disabled by this: the gateway route goes through the daemon,
// a separate process, and does not touch the addon at all.
window.logos.status().then((status) => {
  if (status.addonLoaded) {
    log('Native addon loaded.');
  } else {
    log(`Native addon unavailable: ${status.error}`, true);
    log('The daemon route does not need it; "Load module only" does.');
    els.load.disabled = true;
  }
});
