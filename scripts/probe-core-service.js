#!/usr/bin/env node
// Can logos-js-sdk drive a module through a logosctl daemon's core_service?
//
// probe-sdk.js established that calling a module DIRECTLY over a plain
// transport hangs: capability_module publishes nothing there, so the token
// lookup never lands. Reading logosctl's own client explains why — it never
// calls modules directly either:
//
//   // RpcClient implementation — delegates all calls to daemon's core_service
//   return coreService->invokeRemoteMethod("core_service", method, args);
//
// core_service is the daemon's RPC gateway, registered in-process, and its
// dispatch (core_service_dispatch.cpp) proxies everything:
//
//   callModuleMethod(module, method, args)
//   watchModuleEvents(module, event)
//   loadModule / getStatus / listModules
//
// So the question this answers: can a JS consumer talk to THAT, and reach
// delivery_module through it? If yes, 0.2.0 works with no subprocess per call.
//
//   make probe-core-service
'use strict';

const path = require('node:path');

const PORT = Number(process.env.PROBE_CORE_PORT || 7001);
const CAP_PORT = Number(process.env.PROBE_CAP_PORT || 7002);

if (!process.env.LOGOS_PROTOCOL_LIB) {
  process.env.LOGOS_PROTOCOL_LIB = path.join(
    __dirname, '..', 'liblogos', 'lib', 'liblogos_protocol.so'
  );
}

async function main() {
  const { LogosClient, tcp } = require('logos-js-sdk');

  // The daemon is started separately (see the make target), so this only
  // connects. core_service and capability_module each need their own port —
  // two QTcpServers cannot share an address:port.
  const logos = new LogosClient('electron_poc', {
    transport: tcp('127.0.0.1', PORT),
    capabilityTransport: tcp('127.0.0.1', CAP_PORT),
  });

  // The token the daemon issued, from its session dir. logosctl's own client
  // saves it for both "cli_client" and "core_service" (client.cpp).
  const token = process.env.PROBE_TOKEN;
  if (token) {
    console.log(`saveToken(core_service, <token>) -> ${logos.saveToken('core_service', token)}`);
  } else {
    console.log('no PROBE_TOKEN set — trying unauthenticated');
  }

  const core = logos.module('core_service');

  const withTimeout = (p, ms, label) =>
    Promise.race([
      p,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`${label} did not answer within ${ms}ms`)), ms)
      ),
    ]);

  try {
    const methods = core.getMethods();
    console.log(`\ncore_service.getMethods() -> ${methods.length} methods`);
    if (methods.length) {
      console.log(`  ${methods.map((m) => m.name).join(', ')}`);
    }
  } catch (err) {
    console.log(`\ncore_service.getMethods() failed: ${err.message}`);
  }

  // getStatus first: no arguments, no module involved — the cleanest test of
  // whether core_service answers at all.
  try {
    const status = await withTimeout(core.call('getStatus'), 15000, 'getStatus');
    console.log(`\ngetStatus() -> ${JSON.stringify(status).slice(0, 300)}`);
    console.log('\nPASS: the SDK reached core_service over TCP');
  } catch (err) {
    console.log(`\ngetStatus() failed: ${err.message}`);
    console.log('\nFAIL: core_service did not answer');
    process.exitCode = 2;
    return;
  }

  // The actual goal: proxy a call to delivery_module through the gateway.
  try {
    const result = await withTimeout(
      core.call('callModuleMethod', 'delivery_module', 'getAvailableConfigs', []),
      20000,
      'callModuleMethod'
    );
    console.log(`\ncallModuleMethod(delivery_module, getAvailableConfigs) -> ${JSON.stringify(result).slice(0, 400)}`);
    console.log('\nPASS: a module call was proxied through core_service');
  } catch (err) {
    console.log(`\ncallModuleMethod failed: ${err.message}`);
    process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});
