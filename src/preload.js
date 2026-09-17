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
});
