#!/usr/bin/env node
// EXPERIMENT 2 driver: does an IN-PROCESS caller reach a real module?
//
// If yes, 0.3.0 needs no published core_service at all — the gateway is only
// there so an out-of-process client has something to talk to.
//
//   make exp-call
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const MODULE = process.env.MODULE || 'delivery_module';
const METHOD = process.env.EXP_METHOD || 'getAvailableConfigs';

const addon = require(path.join(__dirname, 'build', 'Release', 'exp_call.node'));

const modulesDir = path.join(__dirname, '..', '..', 'modules');
const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-call-'));

// Pump from the start: module bring-up and the call both need the loop
// serviced, and there is no harm in it being on early.
const pump = setInterval(() => addon.tick(), 5);

// The ORIGIN identity. module_manager.cpp's kTrustedCallers = {"core",
// "core_service"} are "always allowed past the dependency check", and the
// daemon registers its gateway under exactly that name — so calling as
// core_service is what the reference implementation effectively does.
const origin = process.env.EXP_ORIGIN || 'core_service';

console.log(`[exp-call] origin=${origin} module=${MODULE} method=${METHOD}`);
addon.setup(modulesDir, persistDir, origin);

const loaded = addon.loadModule(MODULE);
console.log(`[exp-call] loadModule(${MODULE}) -> ${loaded}`);
if (!loaded) {
  clearInterval(pump);
  console.log('\nFAIL: module did not load');
  process.exit(1);
}

// The module is marked loaded before it finishes publishing its object (the
// gap core_service_impl.cpp:598 documents at length, and why watchModuleEvents
// uses onEventWhenAvailable). Give it a beat, pumping throughout.
setTimeout(() => {
  let raw;
  try {
    raw = addon.callModule(MODULE, METHOD, process.env.EXP_ARGS || '[]');
  } catch (err) {
    clearInterval(pump);
    console.log(`\nFAIL: callModule threw: ${err.message}`);
    process.exit(2);
  }
  clearInterval(pump);

  const r = JSON.parse(raw);
  console.log(`[exp-call] ok=${r.ok} code=${r.code} origin=${r.origin}`);
  console.log(`[exp-call] message=${JSON.stringify(r.message)}`);
  console.log(`[exp-call] value=${JSON.stringify(r.value).slice(0, 400)}`);

  // ok=true is the RPC round trip succeeding. The module's own answer may
  // still be a refusal ("Context not initialized" — it wants createNode first),
  // and that is a PASS for this experiment: it means the module talked.
  if (r.ok) {
    console.log('\nPASS: an in-process caller invoked a real module method');
    process.exit(0);
  }
  console.log('\nFAIL: the invocation did not complete');
  process.exit(2);
}, 3000);
