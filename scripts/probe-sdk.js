#!/usr/bin/env node
// Can logos-js-sdk actually CALL the delivery module?
//
// probe-transport.js proved the module binds a TCP port. This goes the next
// step: connect to it as an out-of-process consumer and invoke a method. If
// this works, driving the module from the app is a matter of wiring, and 0.2.0
// is mostly UI.
//
// The method under test is getAvailableConfigs() — read-only, no arguments, and
// it must answer before createNode() can be called with anything sensible.
//
//   make probe-sdk
'use strict';

const path = require('node:path');
const core = require('../src/index.js');

const modulesDir = path.join(__dirname, '..', 'modules');
const MODULE = 'delivery_module';
const PORT = Number(process.env.PROBE_PORT || 6001);
const CAP_PORT = Number(process.env.PROBE_CAP_PORT || 6002);

// The SDK loads liblogos_protocol itself, separately from the addon. In the
// packaged app this points into the bundle; here, at the nix result.
if (!process.env.LOGOS_PROTOCOL_LIB) {
  process.env.LOGOS_PROTOCOL_LIB = path.join(
    __dirname, '..', 'liblogos', 'lib', 'liblogos_protocol.so'
  );
}

async function main() {
  const tcpSet = (port) =>
    JSON.stringify([{ protocol: 'tcp', host: '127.0.0.1', port, codec: 'json' }]);

  core.init();
  core.addModulesDir(modulesDir);
  core.setModuleTransports(MODULE, tcpSet(PORT));

  // capability_module NEEDS ONE TOO. LogosClient dials it for a per-target
  // token (opts.capabilityTransport, defaulting to the target's transport), so
  // with capability_module on LocalSocket the SDK cannot reach it — and every
  // call then hangs waiting on a token lookup that never lands.
  //
  // It is loaded by start(), so its transport must be registered before that.
  core.setModuleTransports('capability_module', tcpSet(CAP_PORT));

  core.start();

  if (!core.loadModule(MODULE)) {
    throw new Error(`${MODULE} failed to load`);
  }
  console.log(`\n${MODULE} loaded`);

  // Which ports actually got bound. If capability_module is not on CAP_PORT,
  // the token lookup has nowhere to go and every call hangs regardless of what
  // was registered.
  try {
    const { execFileSync } = require('node:child_process');
    const listening = execFileSync('ss', ['-ltn'], { encoding: 'utf8' });
    for (const port of [PORT, CAP_PORT]) {
      const bound = listening.split('\n').some((l) => l.includes(`:${port}`));
      console.log(`  port ${port}: ${bound ? 'LISTENING' : 'not bound'}`);
    }
  } catch {
    console.log('  (ss unavailable — cannot check ports)');
  }

  // A token, to skip a handshake that plain transport cannot carry. The key
  // format is not documented here, so try the plausible spellings and report
  // which (if any) core knows.
  const tokenKeys = [MODULE, `${MODULE}_token`, `token_${MODULE}`, 'electron_poc'];
  let token = null;
  for (const key of tokenKeys) {
    const value = core.getToken(key);
    console.log(`  getToken(${JSON.stringify(key)}) -> ${value ? 'found' : 'null'}`);
    if (value && token === null) token = value;
  }

  // WHO WE CALL AS. module_manager.cpp keeps a kTrustedCallers list —
  // {"core", "core_service"} — that is "always allowed past the dependency
  // check, so they're never locked out", and the same two plus
  // capability_module are never restricted as targets.
  //
  // So the origin identity is not cosmetic, and "electron_poc" is an
  // unprivileged stranger. Try a trusted one too.
  const origin = process.env.PROBE_ORIGIN || 'electron_poc';
  console.log(`\ncalling as origin module: ${origin}`);

  const { LogosClient, tcp } = require('logos-js-sdk');
  const logos = new LogosClient(origin, {
    transport: tcp('127.0.0.1', PORT),
    // Named explicitly: it defaults to the TARGET's transport, which would dial
    // delivery_module's port looking for capability_module.
    capabilityTransport: tcp('127.0.0.1', CAP_PORT),
  });
  const delivery = logos.module(MODULE);

  if (token !== null) {
    // Two different things, and it is not obvious which this path needs:
    //   saveToken   — purely local, so the target "skips the handshake"
    //   informToken — registers the token WITH capability_module, which is what
    //                 LogosAPIClient's TokenManager does on the C++ side
    console.log(`\nsaveToken(${MODULE}, <token>) -> ${logos.saveToken(MODULE, token)}`);
    try {
      const informed = delivery.informToken(token, MODULE, token);
      console.log(`informToken(<token>, ${MODULE}, <token>) -> ${informed}`);
    } catch (err) {
      console.log(`informToken failed: ${err.message}`);
    }
  } else {
    console.log('\nno token found — calls will likely hang on the handshake');
  }

  // Introspection first: it says whether the consumer can see the module at all,
  // and names the methods actually exposed over this transport.
  try {
    const methods = delivery.getMethods();
    console.log(`\ngetMethods() -> ${JSON.stringify(methods).slice(0, 600)}`);
  } catch (err) {
    console.log(`\ngetMethods() failed: ${err.message}`);
  }

  // A call that never settles is the interesting failure here, so each one gets
  // a deadline. Without it the process just hangs and says nothing about why.
  const withTimeout = (promise, ms, label) =>
    Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`${label} did not answer within ${ms}ms`)), ms)
      ),
    ]);

  // Does capability_module answer on ITS port? getMethods() against it is the
  // control: if the target answers introspection but capability_module does
  // not, the token lookup has nowhere to land and every call waits forever.
  try {
    const cap = logos.module('capability_module');
    const capMethods = cap.getMethods();
    console.log(
      `\ncapability_module.getMethods() -> ${capMethods.length} methods` +
        (capMethods.length ? ` (${capMethods.slice(0, 4).map((m) => m.name).join(', ')}…)` : '')
    );
  } catch (err) {
    console.log(`\ncapability_module.getMethods() failed: ${err.message}`);
  }

  // Only methods getMethods() actually reported. getAvailableConfigs is in the
  // Qt metadata but was not in that list, which may itself be the answer.
  for (const method of ['getAvailableConfigs', 'start']) {
    try {
      const result = await withTimeout(delivery.call(method), 15000, method);
      console.log(`\n${method}() -> ${JSON.stringify(result).slice(0, 400)}`);
      console.log(`\nPASS: the SDK reached the module and ${method}() answered`);
      core.cleanup();
      return;
    } catch (err) {
      console.log(`\n${method}() failed: ${err.message}`);
    }
  }

  console.log('\nFAIL: the module loaded, bound a port and answered getMethods(),');
  console.log('  but no invocation completed — see the handshake warning above.');
  process.exitCode = 2;

  core.cleanup();
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});
