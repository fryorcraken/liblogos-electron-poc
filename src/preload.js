// The only bridge between the renderer and the liblogos runtime.
//
// Each method is named and fixed — the renderer cannot reach an arbitrary IPC
// channel, let alone the addon. With contextIsolation on, this is what
// window.logos is in the renderer.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Unwraps the {ok, value} envelope from main.js back into a normal promise, so
// renderer code reads as plain async calls.
async function call(channel, ...args) {
  const reply = await ipcRenderer.invoke(channel, ...args);
  if (!reply.ok) throw new Error(reply.error);
  return reply.value;
}

contextBridge.exposeInMainWorld('logos', {
  status: () => call('logos:status'),
  startDelivery: () => call('logos:startDelivery'),

  /** Start the daemon, load the module, and bring a real Waku node up through
   *  the core_service gateway. This is what 0.2.0 added. */
  startNode: () => call('logos:startNode'),

  /** Subscribe to core's log stream. Lines arrive as they are written. */
  onLog: (callback) => {
    // The listener is wrapped rather than passed through, so the renderer never
    // receives the IpcRendererEvent — which would hand it a bridge back into
    // the main process.
    ipcRenderer.on('logos:log', (_event, line) => callback(line));
  },

  /** The module's own events, forwarded by the daemon: connectionStateChanged,
   *  messageReceived and friends. Structured, unlike the log stream. */
  onEvent: (callback) => {
    ipcRenderer.on('logos:event', (_event, payload) => callback(payload));
  },
});
