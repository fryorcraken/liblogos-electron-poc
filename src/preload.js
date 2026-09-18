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

  /** createNode() + start(): a real Waku node, in this process. */
  startNode: () => call('logos:startNode'),

  /** Subscribe to core's log stream. Lines arrive as they are written. */
  onLog: (callback) => {
    // The listener is wrapped rather than passed through, so the renderer never
    // receives the IpcRendererEvent — which would hand it a bridge back into
    // the main process.
    ipcRenderer.on('logos:log', (_event, line) => callback(line));
  },

  /** Subscribe to the module's own events: connectionStateChanged and friends.
   *  Separate from onLog because these are structured and mean something
   *  stronger — the module talking, not a line of spdlog output. */
  onModuleEvent: (callback) => {
    ipcRenderer.on('logos:moduleEvent', (_event, message) =>
      callback(message.event, message.args)
    );
  },
});
