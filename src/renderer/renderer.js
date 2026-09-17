// Renderer: one button, one outcome. Drives window.logos (from preload.js).
// No native code and no Node APIs here — contextIsolation is on.
'use strict';

const els = {
  status: document.getElementById('status'),
  start: document.getElementById('start'),
  log: document.getElementById('log'),
};

function setStatus(text, state) {
  els.status.textContent = text;
  els.status.dataset.state = state;
}

function log(message, isError = false) {
  const line = document.createElement('div');
  if (isError) line.className = 'err';
  line.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  els.log.append(line);
  els.log.scrollTop = els.log.scrollHeight;
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
    }
  } catch (err) {
    setStatus('Failed', 'error');
    log(err.message, true);
    els.start.disabled = false;
  }
});

// Core's own log, streamed from the native side. These are the module's real
// messages — spdlog output from core and from each module host — not this
// renderer's commentary, so they are marked to tell them apart.
window.logos.onLog((line) => {
  const el = document.createElement('div');
  el.className = 'native';
  el.textContent = line;
  els.log.append(el);
  els.log.scrollTop = els.log.scrollHeight;
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
