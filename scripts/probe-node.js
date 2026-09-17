#!/usr/bin/env node
// The 0.2.0 question, under plain Node: does the app's own daemon+gateway code
// actually start a Waku node and produce continuous events?
//
// probe-core-service.js proved a single call could be proxied. This drives the
// REAL modules the Electron app uses (src/daemon.js, src/gateway.js), so a
// failure here is a failure in the app rather than in a script that resembles
// it. It is the headless half of what the button does.
//
//   make probe-node
'use strict';

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { Daemon } = require('../src/daemon.js');
const { Gateway } = require('../src/gateway.js');

const MODULE = process.env.MODULE || 'delivery_module';
const projectRoot = path.join(__dirname, '..');
// How long to sit and watch for events after the node is up.
const WATCH_MS = Number(process.env.PROBE_WATCH_MS || 30000);

const log = (line) => console.log(line);

async function main() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logosctl-probe-'));
  const daemon = new Daemon({
    binary: path.join(projectRoot, 'logosctl', 'bin', 'logosctl'),
    configDir,
    packageDir: projectRoot,
    log,
  });

  let gateway = null;
  try {
    const { corePort, capPort } = await daemon.start(MODULE);

    // AFTER the daemon booted, never before: auto.json is rewritten each boot.
    const token = daemon.token();
    log(`token: ${token ? 'read from the daemon session' : 'MISSING — calls will hang'}`);

    gateway = new Gateway({
      corePort,
      capPort,
      token,
      protocolLib: path.join(projectRoot, 'liblogos', 'lib', 'liblogos_protocol.so'),
      log,
    });

    const status = await gateway.getStatus();
    log(`\ngetStatus() -> ${JSON.stringify(status).slice(0, 200)}`);

    // Subscribe BEFORE starting the node, so nothing emitted during bring-up is
    // missed. The daemon forwards only what it is already watching.
    let events = 0;
    const watched = await gateway.watchEvents(MODULE, (event, data) => {
      events += 1;
      log(`  event ${event}: ${JSON.stringify(data).slice(0, 200)}`);
    });
    log(`\nwatching: ${watched.join(', ') || 'nothing'}`);

    log('');
    await gateway.startNode(MODULE);

    log(`\nwatching for events for ${WATCH_MS / 1000}s…`);
    await new Promise((resolve) => setTimeout(resolve, WATCH_MS));

    log(`\n${events} event(s) received`);
    log(events > 0
      ? 'PASS: the node is up and the module is emitting'
      : 'PARTIAL: the node started but emitted nothing in the window');
  } finally {
    if (gateway) gateway.destroy();
    daemon.stop();
    // The daemon is stopped asynchronously and detached; give it a moment before
    // the process (and the probe's own session dir) goes away.
    await new Promise((resolve) => setTimeout(resolve, 2000));
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`\nerror: ${err.message}`);
  process.exit(1);
});
