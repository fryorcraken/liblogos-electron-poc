#!/usr/bin/env node
// 0.3.0, headless: the SHIPPED addon starting a real Waku node in-process.
//
//   make probe-inproc
//
// The experiments under scripts/exp-provider/ proved the mechanism in a second,
// throwaway addon. This drives src/addon.cc and src/index.js — the code the app
// actually ships — so a pass here is a statement about the product rather than
// about a prototype that resembles it.
//
// It is the 0.3.0 counterpart of scripts/probe-node.js, which does the same job
// for the 0.2.0 daemon route. Both exist because the Electron smoke tests can
// only tell you THAT something failed; these tell you where.
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const MODULE = process.env.MODULE || 'delivery_module';

// A flat JSON object of WakuNodeConf fields. A `preset` is what makes the node
// do anything: it populates entry nodes, cluster id and sharding together, where
// "{}" starts a node with nobody to dial and sits silent. "logos.test" rather
// than "twn" because twn is RLN-protected and wants a registered membership this
// PoC does not have.
const NODE_CONFIG = process.env.NODE_CONFIG || JSON.stringify({ mode: 'Core', preset: 'logos.test' });

// How long to watch for events after start(). Connection traffic begins within
// a second or two on a working network; this is generous so a slow DNS or a
// cold peer list does not read as a failure.
const WATCH_MS = Number(process.env.WATCH_MS || 20000);

const core = require(path.join(__dirname, '..', 'src', 'index.js'));

const modulesDir = path.join(__dirname, '..', 'modules');
const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-inproc-'));

const events = [];

async function main() {
  console.log(`modules dir: ${modulesDir}`);
  console.log(`persistence: ${persistDir}`);

  core.init();
  core.addModulesDir(modulesDir);
  core.setPersistenceBasePath(persistDir);
  core.start(); // also starts the Qt pump — see src/index.js
  console.log(`known: ${core.knownModules().join(', ')}`);

  const loaded = core.loadModule(MODULE);
  console.log(`loadModule(${MODULE}) -> ${loaded}`);
  if (!loaded) throw new Error('module did not load');

  // SUBSCRIBE BEFORE createNode, with no settling delay.
  //
  // Both halves of that matter. onEventWhenAvailable is specified to survive the
  // window where a module is loaded but has not published yet, and subscribing
  // immediately is what exercises it. And the module wires its own event
  // callback only once createNode succeeds, so a subscription taken afterwards
  // could miss the first connectionStateChanged.
  //
  // The empty event name is the wildcard: every event on the module.
  const subscriptionId = core.watchModule(MODULE, '', (event, args) => {
    events.push(event);
    console.log(`  EVENT ${event}: ${JSON.stringify(args).slice(0, 200)}`);
  });
  console.log(`watchModule(${MODULE}, *) -> id=${subscriptionId}`);
  if (subscriptionId === 0) throw new Error('subscription refused');

  // createNode then start, the module's documented order. Both are async here
  // only because the binding is — the module side is synchronous and answers
  // once it has really done the work.
  console.log(`createNode(${NODE_CONFIG})`);
  const created = await core.callModule(MODULE, 'createNode', [NODE_CONFIG]);
  console.log(`  -> ${JSON.stringify(created)}`);
  if (created && created.success === false) {
    throw new Error(`createNode refused: ${created.error || 'no reason given'}`);
  }

  console.log('start()');
  const started = await core.callModule(MODULE, 'start', []);
  console.log(`  -> ${JSON.stringify(started)}`);
  if (started && started.success === false) {
    throw new Error(`start refused: ${started.error || 'no reason given'}`);
  }

  // Now that a context exists this answers, and it is the module's own account
  // of what createNode accepts — the one place that documentation is authoritative.
  const configs = await core.callModule(MODULE, 'getAvailableConfigs', []);
  console.log(`getAvailableConfigs -> ${JSON.stringify(configs).slice(0, 300)}`);

  console.log(`\nwatching for events for ${WATCH_MS} ms…`);
  await new Promise((resolve) => setTimeout(resolve, WATCH_MS));

  console.log(`\nevents received: ${events.length} (${[...new Set(events)].join(', ') || 'none'})`);
  core.cleanup();

  // The node running is the claim; events are the evidence FOR it. A run that
  // started a node and observed nothing has not shown the thing 0.3.0 is for —
  // a log that keeps moving — so it is not scored as a pass.
  if (events.length === 0) {
    console.log('\nFAIL: the node started but emitted nothing. No evidence it is on a network.');
    process.exit(1);
  }
  console.log('\nPASS: a Waku node started in-process and streamed events, with no daemon');
  process.exit(0);
}

main().catch((err) => {
  console.error(`\nFAIL: ${err.message}`);
  try {
    core.cleanup();
  } catch {
    // Going away anyway.
  }
  process.exit(1);
});
