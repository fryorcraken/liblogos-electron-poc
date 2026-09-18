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

// THREE ROUTES, NAMED FOR WHAT THEY ACTUALLY DO.
//
// The app keeps all three side by side deliberately: they are the evidence
// behind the README's FFI-vs-glue comparison, and each proves something the
// others do not.
//
//   loadOnly            0.1.0 — logos_core_*'s C ABI. Loads the module and
//                       stops there; it cannot call it. Plain C, bindable from
//                       any language.
//   startViaLogosctl    0.2.0 — a logosctl daemon beside the app, driven over
//                       its core_service gateway with the Qt-free JS SDK.
//   startViaInProcess   0.3.0 — the addon calls the module itself. No daemon,
//                       no gateway, no transport. Needs Qt C++.
contextBridge.exposeInMainWorld('logos', {
  status: () => call('logos:status'),

  /** 0.1.0: load delivery_module through the C ABI. Loads only — nothing here
   *  can call the module, which is the gap the other two close. */
  loadOnly: () => call('logos:loadOnly'),

  /** 0.2.0: start the daemon, load the module into it, and bring a real Waku
   *  node up through the core_service gateway. */
  startViaLogosctl: () => call('logos:startViaLogosctl'),

  /** 0.3.0: createNode() + start() from the addon, in this process. */
  startViaInProcess: () => call('logos:startViaInProcess'),

  /** Subscribe to core's log stream. Lines arrive as they are written. */
  onLog: (callback) => {
    // The listener is wrapped rather than passed through, so the renderer never
    // receives the IpcRendererEvent — which would hand it a bridge back into
    // the main process.
    ipcRenderer.on('logos:log', (_event, line) => callback(line));
  },

  /** The module's own events: connectionStateChanged and friends. Separate from
   *  onLog because these are structured and mean something stronger — the
   *  module talking, not a line of spdlog output.
   *
   *  Both routes deliver here in the same shape, so the renderer does not care
   *  which one produced the event. */
  onModuleEvent: (callback) => {
    ipcRenderer.on('logos:moduleEvent', (_event, message) =>
      callback(message.event, message.args)
    );
  },
});
