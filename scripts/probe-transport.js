#!/usr/bin/env node
// Finds the transport JSON that logos_core actually accepts.
//
// logos_transport_config.h names the C++ enumerators (LocalSocket, Tcp, TcpSsl,
// Json, Cbor) but not their JSON spellings, and the serializer lives in the
// cpp-sdk rather than this tree. The library's string table has "tcp_ssl",
// "json" and "cbor" in it, which says the encoding is lower_snake_case — so
// "tcp" is the obvious candidate, but obvious is not verified.
//
// Rather than guess, this asks core: register a transport set for
// delivery_module, load it, and see whether anything is listening on TCP.
// Run it as `make probe-transport`.
'use strict';

const path = require('node:path');
const { execFileSync } = require('node:child_process');
const core = require('../src/index.js');

const modulesDir = path.join(__dirname, '..', 'modules');
const MODULE = 'delivery_module';
const PORT = Number(process.env.PROBE_PORT || 6001);

// The spelling under test. Override to try another:
//   make probe-transport PROBE_PROTOCOL=Tcp
const protocol = process.env.PROBE_PROTOCOL || 'tcp';
const transportSet = JSON.stringify([
  { protocol, host: '127.0.0.1', port: PORT, codec: 'json' },
]);

console.log(`transport set: ${transportSet}\n`);

core.init();
core.addModulesDir(modulesDir);

try {
  core.setModuleTransports(MODULE, transportSet);
  console.log('setModuleTransports: accepted (it returns void, so this only');
  console.log('  means it did not abort — the real test is the port below)');
} catch (err) {
  console.error(`setModuleTransports threw: ${err.message}`);
  process.exit(1);
}

core.start();
const ok = core.loadModule(MODULE);
console.log(`\nloadModule(${MODULE}) -> ${ok}`);

// The actual verdict: is the module listening where it was told to?
let listening = '';
try {
  listening = execFileSync('ss', ['-ltnp'], { encoding: 'utf8' });
} catch {
  try {
    listening = execFileSync('netstat', ['-ltnp'], { encoding: 'utf8' });
  } catch {
    console.log('\n(neither ss nor netstat available — cannot check the port)');
  }
}

const hit = listening
  .split('\n')
  .filter((line) => line.includes(`:${PORT}`))
  .join('\n');

console.log(`\nlistening on :${PORT}?`);
console.log(hit || `  no — nothing bound to ${PORT}`);

core.cleanup();
process.exit(hit ? 0 : 2);
