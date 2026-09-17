# 0.2.0 — driving the module

0.1.0 proves the packaging: an AppImage that brings up `delivery_module` and its
dependency chain on a machine with no Nix. It never calls the module. 0.2.0 was
meant to close that gap — `createNode()`, a real Waku node, a log that keeps
moving.

**Status: blocked upstream.** Everything on this side works; the last hop does
not. What follows is what was established by experiment, so the next person does
not repeat it.

## What works

`make probe-transport` and `make probe-sdk` are the two experiments, both
reproducible.

**1. Modules can be given a TCP transport.** `logos_core_set_module_transports`
is now bound in `src/addon.cc`. The JSON spelling is not documented anywhere in
this tree, so it was found by trying one and watching for a listening socket:

```json
[{"protocol": "tcp", "host": "127.0.0.1", "port": 6001, "codec": "json"}]
```

`protocol` is lower_snake_case (`tcp`, and `tcp_ssl` per the library's string
table). With that set, `logos_host` binds the port:

```
LISTEN 127.0.0.1:6001  users:(("logos_host",pid=…,fd=9))
```

**2. The SDK connects and introspects.** `logos-js-sdk` — a Qt-free koffi
wrapper over the `lp_*` ABI in `liblogos_protocol`, which this bundle already
ships — reaches the module over that port and reads its full interface:

```
createNode(QString) -> LogosResult      start() -> LogosResult
stop() -> LogosResult                   send(QString,QByteArray) -> LogosResult
subscribe(...)                          …
```

So the transport, the wire format and the module's metadata all work end to end
from plain Node.

**3. A capability token is obtainable.** `logos_core_get_token` is bound too;
`getToken("delivery_module")` returns a token, and the SDK's
`saveToken(module, token)` accepts it.

## What does not work

**No invocation ever completes.** Every call — `getAvailableConfigs()`,
`start()`, with or without a pre-seeded token — hangs until the client's own
deadline. It does not error; nothing answers.

The module says why at load time:

```
[delivery_module] Warning: PlainTransportHost::publishObject: expected
  ModuleProxy for "delivery_module__handshake"
  (plain transport only publishes ModuleProxy for now)
```

That string is in `liblogos_protocol.so`, so it is an upstream limitation rather
than a misconfiguration here. The reading that fits every observation: a plain
(non-Qt) transport publishes only enough for introspection, and the handshake
surface a caller needs to actually invoke a Qt module is not published over it
yet.

Consistent with that, the SDK's own e2e test (`test/e2e.js`) is **JS client → JS
provider**, with both halves agreeing on an arbitrary token string. Nothing in
it exercises a JS client against a C++ Qt module, which is the path this needs.

### Ruled out: the capability transport

`LogosClient` takes a `capabilityTransport` (defaulting to the target's), because
it dials `capability_module` for a per-target token. An obvious theory was that
calls hung because `capability_module` was still on LocalSocket, unreachable
from the SDK.

It is not that. Giving `capability_module` its own TCP transport on a second
port, and pointing `capabilityTransport` at it explicitly, changes nothing:

```
  port 6001: LISTENING     (delivery_module)
  port 6002: LISTENING     (capability_module)
  …both log the same handshake warning, and every call still hangs
```

So the limitation is not about which modules have a transport. It is that a
plain transport does not publish the surface an invocation needs, whichever
module is behind it. `make probe-sdk` reproduces this.

### Ruled out: both token mechanisms

The SDK offers two, and neither helps:

| call | what it does | result |
| --- | --- | --- |
| `saveToken(module, token)` | local pre-seed, "so a target skips the capability handshake" | returns `true`, calls still hang |
| `informToken(auth, module, token)` | registers the token *with* `capability_module` | returns `true`, calls still hang |

The token itself is real — `logos_core_get_token("delivery_module")` returns
one, and both calls accept it. It is not a token problem.

### What the C++ client has that the SDK does not

`logos_api_client.h` describes precisely the topology built here — "CLI on host
→ core_service over TCP, but capability_module also over TCP on a sibling port"
— so TCP invocation clearly does work through `LogosAPIClient`. Its constructor
takes a **`TokenManager*`** alongside the two transports:

```cpp
LogosAPIClient(const QString& module_to_talk_to,
               const QString& origin_module,
               TokenManager* token_manager,
               const LogosTransportConfig& target_transport,
               const LogosTransportConfig& capability_transport, …);
```

That token manager participates in the `requestModule` handshake on the hot
path. The SDK's `saveToken`/`informToken` are evidently not equivalent to it for
a Qt target — which lines up with the plain-transport warning, and with the
SDK's e2e test only ever talking to a JS provider.

## What would unblock it

One of, roughly in order of how much work they are for someone else:

1. **Upstream: publish the handshake surface over plain transport.** The "for
   now" in that warning suggests it is known and intended. This is the clean fix
   and everything here would then work unchanged.
2. **Find the token protocol for plain transport.** If invocation is only
   waiting on a token delivered a particular way, `informToken` (also on the
   SDK client) may be the missing step — but the token's expected form and the
   order of operations are undocumented here, and guessing at an auth handshake
   is a poor use of time.
3. **Wrap `LogosAPIClient` in the addon instead.** Abandons the Qt-free premise
   and puts the Qt invocation layer back in C++, but it is the path liblogos
   itself uses, so it is known to work. Bigger change: async results, event
   subscription and Qt types all have to cross into JS.

## Also worth knowing

- `loadModule` blocks the main thread, and so would a synchronous `createNode`.
  A helper process gets more attractive once the app is doing something
  continuous.
- `configureRln(QString)` and `rlnBridgeEnable()` exist, and the keystore now
  works (0.1.0 sets the persistence path), but no membership is registered.
- The probes are kept as Makefile targets deliberately: when the upstream gap
  closes, `make probe-sdk` is the one-command check for whether it did.
