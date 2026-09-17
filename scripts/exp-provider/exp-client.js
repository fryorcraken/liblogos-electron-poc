#!/usr/bin/env node
// EXPERIMENT client. A separate process, so "the provider did not answer" and
// "the caller never got to ask" cannot be confused.
//
// Same SDK the 0.2.0 route uses (logos-js-sdk over plain TCP), pointed at the
// experimental provider the addon published in the host process.
'use strict';

const path = require('node:path');

const PORT = Number(process.env.EXP_PORT || 7401);

if (!process.env.LOGOS_PROTOCOL_LIB) {
  process.env.LOGOS_PROTOCOL_LIB = path.join(
    __dirname, '..', '..', 'liblogos', 'lib', 'liblogos_protocol.so'
  );
}

const withTimeout = (p, ms, label) =>
  Promise.race([
    p,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} did not answer within ${ms}ms`)), ms)
    ),
  ]);

async function main() {
  const { LogosClient, tcp } = require('logos-js-sdk');

  // No capabilityTransport: this provider was published by a process that is
  // NOT running liblogos_core, so there is no capability_module anywhere. That
  // is itself part of what this measures — whether a bare published provider
  // is callable without the capability handshake.
  const logos = new LogosClient('exp_client', { transport: tcp('127.0.0.1', PORT) });

  // The token the host registered as INBOUND. saveToken is the client-side
  // outbound half: "when I call exp_service, present this".
  if (process.env.EXP_TOKEN) {
    console.log(`[client] saveToken(exp_service) -> ${logos.saveToken('exp_service', process.env.EXP_TOKEN)}`);
  }

  const svc = logos.module('exp_service');

  let methods = [];
  try {
    methods = svc.getMethods();
    console.log(`[client] getMethods() -> ${methods.length}: ${methods.map((m) => m.name).join(', ')}`);
  } catch (err) {
    console.log(`[client] getMethods() failed: ${err.message}`);
  }

  try {
    const r = await withTimeout(svc.call('echo', 'hello'), 12000, 'echo');
    console.log(`[client] echo('hello') -> ${JSON.stringify(r)}`);
    console.log('[client] OK');
    process.exit(0);
  } catch (err) {
    console.log(`[client] echo failed: ${err.message}`);
    // getMethods() succeeding while echo() hangs is a meaningful distinction:
    // it would mean introspection is served but dispatch is not.
    console.log(
      methods.length
        ? '[client] NOTE: introspection worked, dispatch did not'
        : '[client] NOTE: nothing answered at all'
    );
    process.exit(2);
  }
}

main().catch((err) => {
  console.error(`[client] error: ${err.message}`);
  process.exit(1);
});
