#!/usr/bin/env node
// EXPERIMENT 3 driver: does an in-process subscriber receive a module's events?
//
//   make exp-event
//
// docs/0.3.0-inventory.md §5.2 names this the one inventory item with zero
// evidence. It is deliberately the FIRST thing 0.3.0 does, because a failure
// here is worth knowing before anything is built on top of it.
//
// WHAT THIS HAS TO DISTINGUISH, and why the output is shaped the way it is:
//
//   never armed      the subscription was deferred forever. Fatal — it means
//                    onEventWhenAvailable does not see the module at all.
//   armed, silent    the plumbing works and the module simply did not emit.
//                    Not a failure of 0.3.0; a question about the trigger.
//   armed, delivered the result we want.
//
// "No events arrived" on its own says nothing, so `armed` is reported and
// asserted separately from delivery. pendingEventSubscriptions() is the
// tie-breaker: a subscription still listed there never armed, full stop.
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const MODULE = process.env.MODULE || 'delivery_module';

// THE WILDCARD, and not `nodeStarted`.
//
// README.md's module-surface listing names a `nodeStarted(bool,QString,int)`
// signal and this experiment's first run subscribed to it. It ARMED and
// delivered nothing — because there is no such event. `grep -rn nodeStarted`
// over all of ~/src/logos-co returns zero hits; delivery_module_plugin.h's
// contract block lists exactly five:
//
//   messageSent  messageError  messagePropagated  messageReceived
//   connectionStateChanged
//
// createNode() and start() are synchronous and return bool, so "the node
// started" is a return value, not a signal. README.md is wrong about this and
// is corrected separately.
//
// That first run is worth keeping in the record for what it accidentally
// proved: onEventWhenAvailable ARMED on an event name that does not exist.
// Arming means the module was REACHED, not that the name is valid — so "armed
// and silent" can always be a typo, and an experiment that checked only `armed`
// would have called a misspelling a success.
//
// An EMPTY event name means "every event on this object" — what
// LogosObject::onEvent has always understood it to mean, and what
// core_service_impl.cpp:598 notes the wildcard `watch <module>` form relies on
// since logos-protocol#74. It is the right subscription for a log pane, and it
// removes the typo failure mode entirely.
const EVENT = process.env.EXP_EVENT !== undefined ? process.env.EXP_EVENT : '';

// Whether to actually provoke the module. createNode(QString) is what starts a
// Waku node; with EXP_TRIGGER=0 the experiment only answers the arming half,
// which is still the more important half.
const TRIGGER = process.env.EXP_TRIGGER !== '0';
const TRIGGER_METHOD = process.env.EXP_TRIGGER_METHOD || 'createNode';

// A flat JSON object of WakuNodeConf fields, and the ONLY shape that produces
// traffic. src/gateway.js pins down why: "{}" is accepted and starts a node with
// nobody to dial, which is silent; a `preset` populates entry nodes, cluster and
// sharding together. Valid presets are "", "twn", "logos.dev", "logos.test" and
// "status.prod" — "default" is not one, and passing it got
// "createNode cfg is not valid JSON" on this experiment's first run.
const TRIGGER_ARGS =
  process.env.EXP_TRIGGER_ARGS ||
  JSON.stringify([JSON.stringify({ mode: 'Core', preset: 'logos.test' })]);

// How long to wait for events AFTER the trigger returns. createNode starts a
// real node and discovers peers, so this is generous on purpose.
const WAIT_MS = Number(process.env.EXP_WAIT_MS || 25000);

const addon = require(path.join(__dirname, 'build', 'Release', 'exp_event.node'));

const modulesDir = path.join(__dirname, '..', '..', 'modules');
const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-event-'));

// Pump from the start. Everything here — bring-up, the subscription arming, the
// event delivery itself — is Qt work that only happens when the loop is
// serviced, and §1 of the inventory established that an explicit pump is what
// works in every configuration.
const pump = setInterval(() => addon.tick(), 5);

let armed = null;
const events = [];

function finish(code, verdict) {
  clearInterval(pump);
  console.log('');
  console.log(verdict);
  process.exit(code);
}

console.log(`[exp-event] module=${MODULE} event=${EVENT} trigger=${TRIGGER ? `${TRIGGER_METHOD}(${TRIGGER_ARGS})` : 'none'}`);
addon.setup(modulesDir, persistDir, process.env.EXP_ORIGIN || 'core_service');

const loaded = addon.loadModule(MODULE);
console.log(`[exp-event] loadModule(${MODULE}) -> ${loaded}`);
if (!loaded) finish(1, 'FAIL: module did not load');

// SUBSCRIBE IMMEDIATELY, with no settling delay. This is the interesting case,
// not a convenience: a module is marked loaded before it finishes publishing its
// object, and core_service_impl.cpp:598 warns that requestObject()+onEvent() is
// silently refused in that window. onEventWhenAvailable is supposed to survive
// it. Subscribing here is what tests that claim.
const id = addon.watch(MODULE, EVENT, (json) => {
  const msg = JSON.parse(json);
  if (msg.kind === 'armed') {
    armed = msg.armed;
    console.log(`[exp-event] ARMED=${msg.armed} (callback on thread ${msg.thread})`);
    return;
  }
  events.push(msg);
  console.log(
    `[exp-event] EVENT ${msg.event} on thread ${msg.thread}: ${JSON.stringify(msg.args).slice(0, 300)}`
  );
});
console.log(`[exp-event] subscription id=${id}`);
if (id === 0) finish(2, 'FAIL: onEventWhenAvailable refused the subscription (id=0)');

// Give the subscription a chance to arm before provoking the module, and REPORT
// the pending list either way — "still pending" is the diagnosis that separates
// a dead subscription from a quiet module.
setTimeout(() => {
  const pending = addon.pending(MODULE);
  console.log(`[exp-event] pending after 3s: ${pending.length ? pending.join(', ') : '(none)'}`);
  console.log(`[exp-event] armed so far: ${armed}`);

  if (!TRIGGER) {
    return setTimeout(() => report(), WAIT_MS);
  }

  // THE TRIGGER: createNode(cfg) THEN start(), the module's documented order
  // (delivery_module_plugin.h's lifecycle block — createNode exactly once per
  // context, start before any message operation). Both are synchronous and
  // block this thread; §5.1 of the inventory is explicit that no experiment has
  // ever called either.
  //
  // BOTH are required for events, and the reason is mechanical rather than a
  // matter of taste: delivery_module_plugin.cpp:207 wires the FFI event callback
  // with logosdelivery_set_event_callback only AFTER createNode succeeds, so
  // nothing can be emitted before that point no matter who is subscribed. And
  // connection traffic needs the node actually running, which is start().
  const call = (method, argsJson) => {
    console.log(`[exp-event] calling ${method}(${argsJson})…`);
    const began = Date.now();
    let raw;
    try {
      raw = addon.callModule(MODULE, method, argsJson);
    } catch (err) {
      console.log(`[exp-event] ${method} threw: ${err.message}`);
      return null;
    }
    const r = JSON.parse(raw);
    console.log(
      `[exp-event] ${method} -> ok=${r.ok} in ${Date.now() - began} ms: ${JSON.stringify(r.value).slice(0, 300)}`
    );
    return r;
  };

  const created = call(TRIGGER_METHOD, TRIGGER_ARGS);
  // Only start() if createNode actually took. The module answers every other
  // method with "Call createNode first", so starting after a refusal would just
  // produce a second, more confusing refusal.
  if (created && created.ok && created.value !== false) {
    call('start', '[]');
  }

  setTimeout(() => report(), WAIT_MS);
}, 3000);

function report() {
  const pending = addon.pending(MODULE);
  console.log('');
  console.log(`[exp-event] final: armed=${armed} events=${events.length} pending=${pending.length ? pending.join(', ') : '(none)'}`);

  // The three outcomes, kept apart on purpose.
  if (armed !== true) {
    return finish(
      3,
      `FAIL: the subscription never armed (armed=${armed}, pending=${pending.join(', ') || 'none'}).\n` +
        'Event delivery is NOT available in-process. Nothing above this line is a workaround.'
    );
  }
  if (events.length === 0) {
    return finish(
      4,
      'PARTIAL: the subscription ARMED but no event arrived.\n' +
        'The subscription plumbing works; the module emitted nothing on this event\n' +
        'within the window. That is a question about the trigger, not about whether\n' +
        'in-process subscription is possible.'
    );
  }
  return finish(0, `PASS: ${events.length} event(s) delivered to JS from an in-process subscription`);
}
