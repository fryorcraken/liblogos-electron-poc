#!/usr/bin/env node
// The 0.2.0 verification: does the app's OWN IPC handler bring a node up inside
// Electron, and does the log keep moving afterwards?
//
// electron-smoke.js checks the 0.1.0 claim (the addon loads the module in this
// process). This checks the 0.2.0 one, and it is a different claim on a
// different mechanism: a daemon beside the app, driven through core_service.
//
// It invokes the real ipcMain handler rather than reimplementing it, so it
// cannot pass while the button is broken.
//
//   make verify-node
'use strict';

const { app, ipcMain } = require('electron');

const MODULE = process.env.MODULE || 'delivery_module';
// How long to watch for module events once the node is up.
const WATCH_MS = Number(process.env.NODE_SMOKE_WATCH_MS || 45000);

// Loading main.js registers the handlers and creates a window on ready. The
// window is wanted: the log capture starts on did-finish-load, and the renderer
// is where events are sent, so a headless run without it would exercise less
// than the button does.
require('../src/main.js');

// ipcMain.handle registers a handler; invoking it from the main process means
// reaching for the same function rather than going through a renderer.
// _invokeHandlers is Electron-internal, which is the trade: a test that drives
// the real handler, at the cost of a private API. The alternative — a second
// copy of the logic here — is the failure mode this file exists to avoid.
function invoke(channel, ...args) {
  const handler = ipcMain._invokeHandlers.get(channel);
  if (!handler) throw new Error(`no handler registered for ${channel}`);
  return handler({}, ...args);
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  // main.js creates the window on whenReady; wait for that to have happened so
  // the log subscribers are in place before anything is logged.
  await app.whenReady();
  await delay(1500);

  let events = 0;
  const { BrowserWindow } = require('electron');
  for (const win of BrowserWindow.getAllWindows()) {
    // Count what the renderer would receive, without a renderer.
    const send = win.webContents.send.bind(win.webContents);
    win.webContents.send = (channel, payload) => {
      if (channel === 'logos:event') {
        events += 1;
        console.log(`[event] ${payload.event} ${JSON.stringify(payload.data)}`);
      }
      return send(channel, payload);
    };
  }

  console.log(`starting a node via logos:startViaLogosctl (module: ${MODULE})…\n`);
  const reply = await invoke('logos:startViaLogosctl');
  if (!reply.ok) throw new Error(reply.error);

  console.log(`\ndaemon modules: ${reply.value.modules.join(', ')}`);
  console.log(`watching: ${reply.value.watched.join(', ')}`);

  console.log(`\nwatching for events for ${WATCH_MS / 1000}s…`);
  await delay(WATCH_MS);

  console.log(`\n${events} module event(s) reached the renderer`);
  if (events > 0) {
    console.log(`\nPASS: a Waku node is running and ${MODULE} is emitting`);
    app.exit(0);
  } else {
    // Not a pass: the whole point of 0.2.0 is that the log keeps moving.
    console.log('\nFAIL: the node started but no event arrived');
    app.exit(1);
  }
}

main().catch((err) => {
  console.error(`\nFAIL: ${err.message}`);
  app.exit(1);
});
