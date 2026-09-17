# 0.2.0 — actually starting the node

0.1.0 proves the packaging: an AppImage that brings up `delivery_module` and its
dependency chain on a machine with no Nix. It never calls the module. 0.2.0
closes that gap — `createNode()`, a real Waku node, and a log that keeps moving
instead of stopping once bring-up finishes.

This is a plan, not a design doc. Everything below was checked against the
headers and the SDK source in this tree; nothing here has been built yet.

## Why no more C++ is needed

[`logos-js-sdk`](https://github.com/logos-co/logos-js-sdk) (v2.0.0) is a
**Qt-free koffi wrapper** over the `lp_*` C ABI in `liblogos_protocol` — the
library this bundle already ships in `runtime/lib/`. It finds it through
`LOGOS_PROTOCOL_LIB`, which `src/main.js` can point at the bundled copy the same
way it already sets `LOGOS_HOST_PATH`.

```js
const { LogosClient, tcp } = require('logos-js-sdk');
const logos    = new LogosClient('electron_poc', { transport: tcp('127.0.0.1', port) });
const delivery = logos.module('delivery_module');

await delivery.call('createNode', configJson);
delivery.on('nodeStarted', (ok, id, code) => …);
delivery.on('connectionStateChanged', (peer, state) => …);
```

So the work is plumbing and UI, not bindings.

## The one real obstacle: transports

Modules here bind only the default **LocalSocket** (QLocalSocket via
QRemoteObjects), which the SDK cannot speak — it does plain TCP, TCP+SSL or a
plain-local Unix socket. `delivery_module` therefore needs a transport the SDK
can reach, registered **before it loads**:

```c
// logos_core.h — not yet bound in src/addon.cc
void logos_core_set_module_transports(const char* module_name,
                                      const char* transport_set_json);
```

The JSON is a `LogosTransportSet` — an array of `LogosTransportConfig`
(`logos_transport_config.h`):

| field | for TCP |
| --- | --- |
| `protocol` | `Tcp` |
| `host` | `127.0.0.1` |
| `port` | `0` — the daemon picks one |
| `codec` | `Json` (the default, and what the SDK speaks) |

**Open question: port discovery.** With `port: 0` the header says the chosen
port "is written into the endpoint file so clients can find it" — that file's
location and format still has to be found, or a fixed port picked instead and
the collision risk accepted for a PoC.

## Steps

1. Bind `logos_core_set_module_transports` in `src/addon.cc` (same shape as
   `setPersistenceBasePath` — a string in, called before `start()`).
2. Register a TCP transport for `delivery_module`, and resolve its port.
3. Add `logos-js-sdk` as a dependency; point `LOGOS_PROTOCOL_LIB` at the
   bundled `liblogos_protocol.so`. Check it packages cleanly — koffi is itself a
   native module, so it needs the same `asarUnpack` treatment as the addon.
4. Call `getAvailableConfigs()`, then `createNode()` with one of them.
5. Subscribe to `nodeStarted` and `connectionStateChanged`, and stream both into
   the existing log pane.
6. Show peer state in the UI — this is what makes the autoscroll worth having.

## Worth knowing

- **`loadModule` blocks the main thread**, and so will a synchronous
  `createNode`. The SDK's calls are promises over its own transport, so they
  should not, but the module bring-up still freezes the window. Moving the
  runtime to a helper process becomes more attractive once the app is doing
  something continuous.
- **The delivery module's full surface** (from its Qt metadata) is in the
  README; `channelCreate`/`channelSend`/`storeQuery` are the messaging layer
  once a node is up.
- **RLN**: `configureRln(QString)` and `rlnBridgeEnable()` exist, and the
  keystore now works (0.1.0 sets the persistence path), but no membership is
  registered — that is likely its own piece of work.
