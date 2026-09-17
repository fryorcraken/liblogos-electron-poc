// THE EXPERIMENT THAT DECIDES 0.3.0, run inside Electron's main process.
//
// exp-host.js established under plain Node that a provider published by this
// process answers RPC only when Qt's event loop is PUMPED (processEvents from
// a timer); "none" and "thread" both fail. The remaining question is the one
// 0.1.0 deliberately avoided: does pumping Qt's loop from inside Electron's
// main process — where Chromium owns the loop — still work, and does Chromium
// survive it?
//
// A BrowserWindow is created on purpose. A headless main process is not the
// test: the coexistence risk is between Qt's event dispatcher and Chromium's,
// and Chromium's only really runs once there is a window to service.
//
//   make exp-electron EXP_MODE=pump
'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const { app, BrowserWindow } = require('electron');

const MODE = process.env.EXP_MODE || 'pump';
const PORT = Number(process.env.EXP_PORT || 7411);
const TOKEN = process.env.EXP_TOKEN || require('node:crypto').randomBytes(16).toString('hex');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');

let pumpTimer = null;
function finish(code, note) {
  if (pumpTimer) clearInterval(pumpTimer);
  console.log(note);
  app.exit(code);
}

app.whenReady().then(() => {
  // A real window, off-screen. If pumping Qt starves Chromium, this is what
  // notices: the renderer has to load and report back.
  const win = new BrowserWindow({ show: false, width: 400, height: 300 });
  let rendererAlive = false;
  win.webContents.on('did-finish-load', () => {
    rendererAlive = true;
    console.log('[electron] renderer finished loading');
  });
  win.loadURL('data:text/html,<h1>exp</h1>');

  const addon = require(path.join(__dirname, 'build', 'Release', 'exp_provider.node'));
  console.log(`[electron] mode=${MODE} port=${PORT}`);

  const published = addon.publish(PORT, MODE, TOKEN);
  console.log(`[electron] publish -> ${JSON.stringify(published)}`);

  if (MODE === 'pump') {
    pumpTimer = setInterval(() => addon.tick(), 10);
  }

  setTimeout(() => {
    try {
      const { execFileSync } = require('node:child_process');
      const bound = execFileSync('ss', ['-ltn'], { encoding: 'utf8' })
        .split('\n')
        .some((l) => l.includes(`:${PORT}`));
      console.log(`[electron] port ${PORT}: ${bound ? 'LISTENING' : 'NOT BOUND'}`);
    } catch {}

    // The client runs under the SYSTEM node, not Electron: it only needs
    // logos-js-sdk + koffi, and keeping it out of Electron means an Electron
    // problem cannot masquerade as a client problem.
    const client = spawn('node', [path.join(__dirname, 'exp-client.js')], {
      env: { ...process.env, EXP_PORT: String(PORT), EXP_TOKEN: TOKEN },
      stdio: 'inherit',
    });

    client.on('exit', (code) => {
      // Chromium's health AFTER Qt has been pumped for the whole call is half
      // the answer: an RPC that works by wedging the UI is not a usable result.
      const chromiumOk = rendererAlive && !win.isDestroyed();
      console.log(`[electron] renderer alive after the call: ${chromiumOk}`);

      // Prove Chromium is still RESPONSIVE, not merely un-crashed: run JS in
      // the renderer now, and require an answer.
      win.webContents
        .executeJavaScript('1 + 1')
        .then((v) => {
          console.log(`[electron] renderer executeJavaScript(1+1) -> ${v}`);
          finish(
            code === 0 && chromiumOk && v === 2 ? 0 : 2,
            code === 0 && chromiumOk && v === 2
              ? `\nPASS(${MODE}): provider answered RPC inside Electron AND Chromium stayed responsive`
              : `\nFAIL(${MODE}): client=${code} chromium=${chromiumOk}`
          );
        })
        .catch((err) => finish(2, `\nFAIL(${MODE}): renderer unresponsive: ${err.message}`));
    });
  }, 1500);

  setTimeout(() => finish(3, `\nFAIL(${MODE}): timed out`), 45000);
});
