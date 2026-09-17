#!/usr/bin/env node
// EXPERIMENT host, plain Node. Publishes the trivial provider, then forks a
// client that calls it over TCP, and reports whether the call was answered.
//
//   make exp-node EXP_MODE=none     no event loop pumping at all (0.1.0 status quo)
//   make exp-node EXP_MODE=pump     processEvents() from a JS setInterval
//   make exp-node EXP_MODE=thread   a dedicated std::thread running QEventLoop::exec()
//
// Why fork a client instead of calling in-process: a client and a server in one
// process, both needing the same event loop, cannot distinguish "the server
// never answered" from "the client never got to ask". Two processes make the
// failure unambiguous.
'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');

const MODE = process.env.EXP_MODE || 'pump';
const PORT = Number(process.env.EXP_PORT || 7401);

const addon = require(path.join(__dirname, 'build', 'Release', 'exp_provider.node'));

console.log(`[host] mode=${MODE} port=${PORT} pid=${process.pid}`);

// A shared secret, generated here and handed to both halves. This is the
// experiment's stand-in for the daemon's client/auto.json.
const TOKEN = process.env.EXP_TOKEN || require('node:crypto').randomBytes(16).toString('hex');

const published = addon.publish(PORT, MODE, TOKEN);
console.log(`[host] publish -> ${JSON.stringify(published)}`);

// "pump" mode: give Qt a slice of the JS thread on a timer. 10 ms is
// arbitrary-but-small; the point is only whether cooperative pumping is enough
// at all, not to tune it.
let pumpTimer = null;
if (MODE === 'pump') {
  pumpTimer = setInterval(() => addon.tick(), 10);
}

function done(code) {
  if (pumpTimer) clearInterval(pumpTimer);
  process.exit(code);
}

// DID THE PORT ACTUALLY BIND? registryUrl says "local:..." regardless — it is
// a logical registry NAME, not a transport endpoint — so the only honest check
// is whether something is listening.
function reportPort() {
  try {
    const { execFileSync } = require('node:child_process');
    const listening = execFileSync('ss', ['-ltn'], { encoding: 'utf8' });
    const bound = listening.split('\n').some((l) => l.includes(`:${PORT}`));
    console.log(`[host] port ${PORT}: ${bound ? 'LISTENING' : 'NOT BOUND'}`);
    return bound;
  } catch {
    console.log('[host] (ss unavailable)');
    return null;
  }
}

// Give the listener a moment to bind before dialing it.
setTimeout(() => {
  reportPort();
  const client = spawn(
    process.execPath,
    [path.join(__dirname, 'exp-client.js')],
    { env: { ...process.env, EXP_PORT: String(PORT), EXP_TOKEN: TOKEN }, stdio: 'inherit' }
  );
  client.on('exit', (code) => {
    console.log(`[host] client exited ${code}`);
    console.log(
      code === 0
        ? `\nPASS(${MODE}): the published provider answered an RPC`
        : `\nFAIL(${MODE}): the published provider did NOT answer`
    );
    done(code === 0 ? 0 : 2);
  });
}, 1000);

// Hard stop so a hang is a bounded failure rather than a wedged make target.
setTimeout(() => {
  console.log(`\nFAIL(${MODE}): timed out`);
  done(3);
}, 40000);
