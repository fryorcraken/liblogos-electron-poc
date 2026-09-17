// Driving delivery_module through the daemon's core_service gateway.
//
// core_service is not a module you can give a transport to — it is a gateway the
// daemon registers in-process, and its dispatch (core_service_dispatch.cpp in
// logos-logoscore-cli) is a Qt-free `if (methodName == …)` chain over JSON. The
// three methods that matter here:
//
//   callModuleMethod(module, method, args)  -> proxy any module call
//   watchModuleEvents(module, eventName)    -> start forwarding a module's events
//   getStatus()                             -> the daemon's own health
//
// logos-js-sdk talks to it over plain TCP as an ordinary consumer. That works
// where calling delivery_module DIRECTLY does not, because the daemon holds a
// real C++ TokenManager and does the capability handshake on our behalf.
'use strict';

const path = require('node:path');

// The delivery module's own lifecycle contract (delivery_module_plugin.h):
//
//   call createNode exactly once per context
//   call start before message operations
//   … subscribe / send / unsubscribe …
//   call stop before shutdown
//
// All of these are SYNCHRONOUS on the module side and return a bool. So the
// gateway call returns once the module has actually done the work — createNode
// really does stand up a Waku context before answering.
//
// THE CONFIG, and why this one.
//
// createNode takes a flat JSON object of WakuNodeConf fields (delivery's README
// documents them); unknown keys are ignored and every field has a default, so
// "{}" is accepted and starts a node. It is the wrong choice here, though:
// with no entryNodes there is nobody to dial, and the node sits silent — which
// is exactly the "log goes quiet after bring-up" 0.2.0 exists to fix. Verified:
// "{}" started a node and emitted nothing for 30s.
//
// A `preset` populates cluster id, entry nodes, sharding and RLN together, and
// its bootstrap nodes are where the connection traffic comes from. The valid
// names are "", "twn", "logos.dev", "logos.test" and "status.prod" — "default"
// and "waku" are not among them. "twn" is the RLN-protected Waku Network and
// would additionally need a registered membership, which this PoC does not have
// (see NEXT.md on the RLN keystore), so a Logos network is the right target.
//
// ONLY mode/preset/entryLayer/*Overrides at the top level, deliberately.
// Any OTHER bare top-level key — `logLevel` is the easy one to reach for —
// silently selects the backend's legacy flat WakuNodeConf shape instead of this
// one. Both parse, but they are different code paths, and the flat one is what
// the current docs steer away from. Keeping the object to these keys is the
// difference between using the documented shape and accidentally not.
const DEFAULT_NODE_CONFIG = JSON.stringify({
  mode: 'Core',
  preset: 'logos.test',
});

// Events the module emits, from the contract block at the top of
// delivery_module_plugin.h. NOTE: there is no `nodeStarted` event — createNode
// and start are synchronous calls that return bool, so "the node started" is
// their return value, not a signal. The continuous traffic comes from
// connectionStateChanged as peers come and go.
//
//   connectionStateChanged  data[0] connection status, data[1] ISO timestamp
//   messageReceived         hash, content topic, base64 payload, timestamp
//   messageSent / messageError / messagePropagated
const MODULE_EVENTS = [
  'connectionStateChanged',
  'messageReceived',
  'messageSent',
  'messageError',
  'messagePropagated',
];

// core_service forwards every watched module event under ONE event name of its
// own, with the module and the original event name as the first two payload
// entries: emitEvent("module_event", [module, event, ...args]).
// See CoreServiceImpl::watchModuleEvents.
const FORWARDED_EVENT = 'module_event';

class Gateway {
  /**
   * @param {object} opts
   * @param {number} opts.corePort   core_service's TCP port
   * @param {number} opts.capPort    capability_module's TCP port
   * @param {string} opts.token      the token from the daemon's auto.json
   * @param {string} [opts.protocolLib] path to liblogos_protocol.so
   * @param {(line: string) => void} opts.log
   */
  constructor({ corePort, capPort, token, protocolLib, log }) {
    this.log = log || (() => {});

    // koffi dlopens this directly; in a packaged app nothing else will have put
    // it on the search path.
    if (protocolLib) process.env.LOGOS_PROTOCOL_LIB = protocolLib;

    const { LogosClient, tcp } = require('logos-js-sdk');
    this.client = new LogosClient('electron_poc', {
      transport: tcp('127.0.0.1', corePort),
      capabilityTransport: tcp('127.0.0.1', capPort),
    });

    // Pre-seed the daemon's token so the target skips the capability handshake.
    // logosctl's own client saves it under both "cli_client" and "core_service".
    if (token) this.client.saveToken('core_service', token);

    this.core = this.client.module('core_service');
    this.unsubscribes = [];
  }

  /** Raw gateway call, with a deadline. The SDK's own default is 30s and a
   *  hung call is the failure mode this whole route exists to avoid, so every
   *  call here is bounded and says which one timed out. */
  async call(method, ...args) {
    const timeoutMs = 60000;
    return Promise.race([
      this.core.call(method, ...args),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`${method} did not answer within ${timeoutMs}ms`)), timeoutMs)
      ),
    ]);
  }

  /** Proxy a call to a module and unwrap core_service's envelope.
   *
   *  The envelope is {status, module, method, result}. "status":"ok" means the
   *  RPC round-trip succeeded — it says nothing about whether the module liked
   *  the arguments, which is reported inside `result`. Both are returned so a
   *  caller can tell a transport failure from a module's own refusal. */
  async callModule(module, method, args = []) {
    const reply = await this.call('callModuleMethod', module, method, args);
    if (reply && reply.status !== 'ok') {
      const message = reply.message || reply.code || JSON.stringify(reply).slice(0, 200);
      throw new Error(`${module}.${method}: ${message}`);
    }
    return reply ? reply.result : null;
  }

  async getStatus() {
    return this.call('getStatus');
  }

  /** createNode() then start() — the module's documented order.
   *
   *  getAvailableConfigs() is deliberately called AFTER createNode, not before:
   *  it dereferences the delivery context, so before createNode it answers
   *  "Context not initialized". That is the module talking, not an error in the
   *  transport, and it is why a config cannot be discovered first. */
  async startNode(moduleName, config = DEFAULT_NODE_CONFIG) {
    this.log(`createNode(${config})`);
    const created = await this.callModule(moduleName, 'createNode', [config]);
    this.log(`  createNode -> ${JSON.stringify(created)}`);
    if (created && created.success === false) {
      throw new Error(`createNode refused: ${created.error || 'no reason given'}`);
    }

    // Now that a context exists this returns something, and it is the module's
    // own description of what createNode accepts — worth showing once.
    try {
      const configs = await this.callModule(moduleName, 'getAvailableConfigs', []);
      const text = typeof configs?.value === 'string' ? configs.value : JSON.stringify(configs);
      this.log(`  getAvailableConfigs -> ${String(text).slice(0, 400)}`);
    } catch (err) {
      this.log(`  getAvailableConfigs unavailable: ${err.message}`);
    }

    this.log('start() — bringing the Waku node up');
    const started = await this.callModule(moduleName, 'start', []);
    this.log(`  start -> ${JSON.stringify(started)}`);
    if (started && started.success === false) {
      throw new Error(`start refused: ${started.error || 'no reason given'}`);
    }
    return { created, started };
  }

  /** Subscribe to the module's events and stream them to `handler`.
   *
   *  Two halves, and both are required. watchModuleEvents tells the daemon to
   *  start forwarding; the SDK subscription receives what it forwards. Doing
   *  only the first leaves the daemon talking to nobody, and only the second
   *  leaves a subscription nothing is ever sent to.
   *
   *  watchModuleEvents answers false for a module that is not LOADED — that is
   *  the contract it draws deliberately, since a module that is not loaded may
   *  never be. */
  async watchEvents(moduleName, handler, events = MODULE_EVENTS) {
    const off = this.core.on(FORWARDED_EVENT, (module, event, ...data) => {
      if (module !== moduleName) return;
      handler(event, data);
    });
    this.unsubscribes.push(off);

    const watched = [];
    for (const event of events) {
      try {
        const ok = await this.call('watchModuleEvents', moduleName, event);
        if (ok) watched.push(event);
        else this.log(`  watchModuleEvents(${event}) -> false (module not loaded?)`);
      } catch (err) {
        this.log(`  watchModuleEvents(${event}) failed: ${err.message}`);
      }
    }
    return watched;
  }

  destroy() {
    for (const off of this.unsubscribes) {
      try {
        off();
      } catch {
        // Tearing down anyway.
      }
    }
    this.unsubscribes = [];
    try {
      this.client.destroy();
    } catch {
      // Same.
    }
  }
}

module.exports = { Gateway, DEFAULT_NODE_CONFIG, MODULE_EVENTS };
