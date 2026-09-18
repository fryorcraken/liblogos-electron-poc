# 0.2.0 — driving the module

> **STATUS: 0.2.0 IS DONE.** The app runs a `logosctl` daemon, drives
> `delivery_module` through its `core_service` gateway, and a real Waku node
> reaches `Connected`. `make probe-node` (plain Node) and `make verify-node`
> (inside Electron, via the app's own IPC handler) both reproduce it; the
> packaged AppImage ships the daemon. See §"What 0.2.0 ended up being".
>
> **One conclusion below turned out to be wrong**, and is left in place because
> the reasoning that produced it is instructive: "calling a module directly does
> not work" is true only of **Qt-free** consumers. An in-process C++ caller can
> invoke a module with `getClient()` + `invokeRemoteMethod()` — no daemon, no
> gateway, no TCP, no token (`make exp-call`, `docs/0.3.0-inventory.md`). That
> is what makes 0.3.0 much smaller than §"Option 3 in full" assumed.
>
> **Reading this cold?** The one-paragraph version: this PoC loaded
> `delivery_module` but never called it. Calling a module directly from a
> Qt-free consumer does not work (§"The mechanism, pinned down"). Going through
> `core_service` — a gateway that proxies calls — **does**, and is confirmed end
> to end from Node (§"Status of that confirmation"). So 0.2.0 is the gateway
> route with a `logosctl` daemon beside the app, and 0.3.0 calls modules from
> the addon directly. See §"The plan, in two releases".
>
> Everything below was run, not reasoned. Repro targets:
> `make probe-transport`, `make probe-sdk`, `make probe-core-service`.
>
> Source read for this, all under `~/src/logos-co/`:
> `logos-logoscore-cli/src/client/client.cpp` (how the CLI calls),
> `…/src/core_service/core_service_dispatch.cpp` (the gateway's methods),
> `…/src/daemon/daemon.cpp:571` (how it is registered),
> `…/docs/logosctl.md` (daemon config, tokens, transports),
> `logos-liblogos/src/logos_core/module_manager.cpp:294` (trusted callers).

0.1.0 proves the packaging: an AppImage that brings up `delivery_module` and its
dependency chain on a machine with no Nix. It never calls the module. 0.2.0 was
meant to close that gap — `createNode()`, a real Waku node, a log that keeps
moving.

**That gap is now closed** — see the next section. What follows it is the
record of how the route was found, kept because most of it is still the reason
the design is what it is, and because one of its conclusions was wrong in a way
worth seeing.

## What 0.2.0 ended up being

The app spawns a `logosctl` daemon, loads `delivery_module` into it, and drives
that module through the daemon's `core_service` gateway with `logos-js-sdk`.
`src/daemon.js` supervises the daemon; `src/gateway.js` drives the module.

```
createNode({"mode":"Core","preset":"logos.test"})
  createNode -> {"error":null,"success":true,"value":null}
start() — bringing the Waku node up
  start -> {"error":null,"success":true,"value":null}
[event] connectionStateChanged ["Connected",1789652780800796000]
```

Reproduce with `make probe-node` (plain Node) or `make verify-node` (inside
Electron, driving the app's real IPC handler so it cannot pass while the button
is broken). Confirmed in the GUI as well.

### What cost time, and is not obvious from the source

- **`daemon start --detach` works with a piped stdout**, returning in well under
  a second. A bare `daemon start` does not detach when stdout is not a TTY: it
  holds the foreground writing the daemon log and never returns. The probe
  script backgrounds-and-polls because it predates finding `--detach`.
- **`daemon stop` cannot stop a tcp-only daemon.** The CLI dials the LOCAL
  endpoint, which this config removes, so `stop` reports `NO_DAEMON` while the
  daemon is plainly running and holding both ports. An orphan from an earlier
  run then keeps 7001/7002 and every later start comes up without binding. The
  app signals the pid `--detach` printed, and kills whatever holds the port
  before starting. **This is the single nastiest thing here**: the failure looks
  like a transport bug and is a process-lifecycle one.
- **A second `daemon start` rotates the token under the first caller.** It stops
  the previous daemon and rewrites `auto.json`; the earlier client is left with
  a stale token, which does not error — it hangs. Observed as a 60s timeout on
  `getStatus` when a headless run and a button click overlapped.
- **`LOGOSCTL_CONFIG_DIR`** gives the app its own session directory, so it does
  not collide with a `logosctl` the user runs by hand.
- **The config shape matters.** `"{}"` is accepted and starts a node that then
  sits silent — no entry nodes to dial, 0 events in 30s, verified. A `preset`
  brings its own bootstrap nodes. Keep the object to `mode`/`preset`/
  `entryLayer`/`*Overrides`: any other bare top-level key (`logLevel` is the
  easy one to reach for) silently selects the backend's legacy flat config
  shape. Valid presets are `twn`, `logos.dev`, `logos.test`, `status.prod` —
  `twn` is RLN-protected and needs a membership this PoC does not have.
- **There is no `nodeStarted` event**, despite what an earlier draft of this
  file assumed. `createNode` and `start` are synchronous and return bool. The
  continuous traffic is `connectionStateChanged`; the full event list is
  `connectionStateChanged`, `messageReceived`, `messageSent`, `messageError`,
  `messagePropagated`.
- **`watchModuleEvents` forwards under one event name.** The daemon re-emits
  every watched module event as `module_event`, with `[module, event, ...args]`
  as the payload, so a client subscribes to that and demultiplexes. It also
  answers `false` for a module that is not loaded, deliberately.
- **`logosctl` is not statically linked.** It looks like a single binary but is
  a Nix wrapper over `.logosctl-wrapped`, dynamically linked against the whole
  Qt closure and setting `QT_PLUGIN_PATH`/`LOGOS_HOST_PATH` to `/nix/store`
  paths. Packaging it means shipping the wrapped binary, its `lib/`, `modules/`
  and `modules-pkg/` trees, the Qt plugins Qt dlopens by path, and supplying
  that environment from the app.

### What is still not done

- **No message is ever sent or received.** `send()` and `subscribe()` are
  reachable through the same `callModuleMethod` path, but nothing exercises
  them, so `messageSent` / `messageReceived` have never fired in a run.
- **Only one `connectionStateChanged` arrives per run** in the windows tested
  (30–60s): the node reaches `Connected` and then stays there. The log "keeps
  moving" in the sense that events now arrive at all, which is the thing 0.1.0
  lacked — but it is one event, not a stream. Sending messages is what would
  produce continuous traffic.
- **The bring-up blocks the UI.** The daemon work is async, but the SDK's client
  creation and `getMethods` are synchronous FFI on the main thread, and the
  first run installs four packages. The window is unresponsive during it.

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

### The mechanism, pinned down

Two more experiments settle what is actually happening.

**`core_service` is not a module.** It is a privileged *caller identity*.
`module_manager.cpp` keeps `kTrustedCallers = {"core", "core_service"}`, "always
allowed past the dependency check, so they're never locked out", and the same
two plus `capability_module` are never restricted as targets. So there is no
`core_service` to give a transport to — but the origin identity a client calls
*as* does matter. Calling as `core_service` instead of `electron_poc` changes
nothing: every call still hangs. It is not an authorization failure.

**`capability_module` publishes nothing over plain transport.** This is the
actual cause. Asking each module for its interface over its own TCP port:

| module | `getMethods()` |
| --- | --- |
| `delivery_module` | full interface — `createNode`, `start`, `stop`, `send`, `subscribe`, … |
| `capability_module` | **0 methods** |

Its port is bound and accepts connections; there is simply nothing published
behind it. The SDK's per-target token lookup dials that surface, finds nothing
to talk to, and waits — which is exactly why calls hang forever instead of
being refused. It matches the load-time warning about
`capability_module__handshake` precisely.

So the token flow is not reachable over a plain transport at all, and no amount
of token plumbing on the client side can substitute for it.

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

## How other non-C++ clients actually do it

They do not invoke modules directly. `logos-logoscore-py` — "Python wrapper for
the logoscore CLI — launch daemons, load modules, call methods, subscribe to
events" — is explicit about its mechanism:

> The wrapper is a thin layer over the `logoscore` CLI: every operation spawns a
> `logoscore <subcommand> --json` subprocess and parses its output. **No C++
> bindings, no IPC code.**

So the supported route for a non-C++ language is to drive `logosctl`, a C++ Qt
binary that holds a real `TokenManager`, and read its `--json` output:

```
logosctl call MODULE METHOD [args...]
logosctl watch MODULE [--event NAME]
```

**The token is an access-control mechanism, not an obstacle to route around.**
`logosctl`'s session directory has `tokens.json` ("hashed-at-rest accepted
tokens"), per-client token files, and an `auto.json` the daemon rewrites each
boot; the docs warn that plaintext `tcp` to a non-loopback host puts tokens on
the wire in cleartext. A same-host, same-user client picks its token up from
`auto.json` automatically; remote clients are issued one explicitly.

Two things this reveals that the attempt above got wrong:

- **`core_service`.** The working examples pair `core_service` *and*
  `capability_module`, each on its own port ("two `QTcpServer`s can't share an
  address:port"). The attempt above exposed `delivery_module` and
  `capability_module` — there was no `core_service` for a client to talk to.
- **Nothing here is a documented limitation.** "for now" in a warning string is
  an implementation note, not a statement of intent, and it was wrong to
  present it as one.

## What would unblock it

### The plan, in two releases

**0.2.0 — the gateway route. DONE**; see §"What 0.2.0 ended up being". All four
steps below were carried out, with two corrections worth recording:

1. Ship `logosctl` in the AppImage and spawn it from Electron's main process.
   ~~(it is statically linked — only `libc`)~~ **Wrong.** It is a Nix wrapper
   over a dynamically linked binary with the whole Qt closure behind it, and
   packaging it meant shipping its private `lib/`, `modules/` and
   `modules-pkg/` trees plus the Qt plugins Qt dlopens by path. 315 MB → 426 MB.
2. Write its config, start it, read the token from `client/auto.json` **after**
   the daemon boots, and install/load the modules.
3. Replace the addon's `loadModule` path in the UI with SDK calls through the
   gateway, then `createNode()` to actually start the Waku node. (Both buttons
   are kept, so the 0.1.0 claim stays demonstrable.)
4. Subscribe with `watchModuleEvents` and stream ~~`nodeStarted` /~~
   `connectionStateChanged` into the log pane. **There is no `nodeStarted`
   event** — `createNode`/`start` are synchronous and return bool.

Cost: two processes, a second copy of the runtime in the AppImage, and a daemon
lifecycle the app has to manage — including that `daemon stop` cannot stop it.

**0.3.0 — as a lib.** Host `core_service` in the addon instead, as described
below, and delete the daemon. Same UI, same SDK surface, one process.

### The routes, in order of how well-trodden

1. **Drive `logosctl` as a subprocess** — the supported route, and the one
   `logos-logoscore-py` takes. Electron's main process spawns
   `logosctl call delivery_module createNode …` and parses `--json`, and
   `logosctl watch delivery_module` gives the event stream the log pane wants.
   Costs: another binary in the bundle, and a subprocess per call. Buys: the
   token handling, transports and error reporting are all somebody else's
   solved problem, and this is how the Python wrapper ships today.
2. ~~Retry the SDK with `core_service` exposed.~~ **Done — it does not help.**
   `core_service` is a caller identity, not a module, and calling as it changes
   nothing. The blocker is that `capability_module` publishes no methods over a
   plain transport, so the token lookup has nothing to reach. See "The
   mechanism, pinned down" above.
3. **Host `core_service` in the addon — the likely endgoal.** See below.
4. **Upstream: publish `capability_module` over plain transport.** Would make
   the SDK route work as originally hoped, and `make probe-sdk` is the check for
   whether it has happened.

## What a Development Kit would have to expose

Framed as the question "what, exactly, would a Logos dev kit need to offer so a
non-C++ app can host and call modules?" — three pieces, and the awkward part is
that they currently live in three different repos.

| # | Piece | Type(s) | Ships from | In this bundle as |
| --- | --- | --- | --- | --- |
| 1 | **Runtime lifecycle** | the `logos_core_*` C ABI | **logos-liblogos** (`src/logos_core/logos_core.h`) | `liblogos_core.so` |
| 2 | **Provider hosting** | `LogosAPI`, `LogosAPIProvider` | **logos-liblogos** (`logos_api.h`, from the `logos-liblogos-headers` package) | `liblogos_qt_host.so` |
| 3 | **Invocation + auth** | `LogosProviderObject`, `LogosAPIClient`, `TokenManager` | **logos-protocol** (`logos_provider_interface.h`, from the `logos-protocol-lib` package) | `liblogos_protocol.so` |

**1 is solved and is what this PoC already does.** A plain C ABI, wrapped in
`src/addon.cc` in an afternoon. Nothing about it is language-specific — the Rust
PoC binds the same header.

**2 is the barrier.** `LogosAPI` is a `QObject`, and registering a provider goes
through Qt. There is no C ABI for it, so every language binding needs a C++ shim
— and a Qt one at that, which is the whole portability complaint in
`liblogos-rust-poc/QT_PORTABILITY_GAP.md`.

**3 is half-solved, which is the frustrating part.** `logos_provider_interface.h`
already defines a **"Universal interface"** alongside the Qt one:

```cpp
// Two parallel virtual interfaces:
//   Qt interface:        callMethod / getMethods / setEventListener (pure virtual)
//   Universal interface: callMethodStd / getMethodsStd / setEventListenerStd (defaulted)

virtual nlohmann::json callMethodStd(const std::string& methodName,
                                     const nlohmann::json& args);
```

Strings and JSON — exactly the shape a C ABI or an FFI binding wants. But the
*hosting* side (piece 2) and the *token handshake* (`TokenManager`,
`LogosAPIClient::invokeRemoteMethod`) are still Qt C++, so the universal
interface cannot be reached from outside without one.

**The smallest thing that would unlock every language**, in order of how much it
would help:

1. **A C ABI for provider registration** — `logos_provider_register(name,
   transports_json, callback)` over the universal `callMethodStd` shape. That
   alone makes piece 2 bindable from Rust, Go, Node or Python with no Qt.
2. **Publish `capability_module` over plain transport.** Today it publishes
   nothing there (`getMethods() -> 0 methods`), which is why direct invocation
   hangs; fixing it makes the existing `lp_*` C ABI sufficient for *consuming*
   modules, which `logos-js-sdk` already binds.
3. **Ship `core_service` as a library, not only inside the `logosctl` binary.**
   It is already written and already Qt-free in its dispatch; it is just not
   reachable except by running the CLI.

Given (1) or (3), 0.3.0 stops being a C++ project and becomes a binding.

## Option 3 in full: be the daemon

The endgoal is that the Electron app *is* the runtime — no `logosctl` process
beside it, no subprocess per call, one binary in the AppImage that already
loads modules and can also call them.

`logosctl`'s daemon does exactly this in about five lines (`daemon.cpp:571`):

```cpp
// 7. Register core_service as an in-process module via the C++ SDK.
auto* coreServiceApi  = new LogosAPI("core_service", coreTransports);
auto* coreServiceImpl = new CoreServiceImpl();
…
provider->registerObject("core_service", static_cast<LogosProviderObject*>(coreServiceImpl));
```

`CoreServiceImpl` is the gateway every client talks to, and its dispatch
(`core_service_dispatch.cpp`) is a plain `if (methodName == …)` chain over
`nlohmann::json` — explicitly headed **"Universal interface — Qt-free
dispatch"**. The part this PoC needs is small:

```cpp
callModuleMethod(module, method, args)    // proxy any module call
watchModuleEvents(module, event)          // the event stream the log pane wants
loadModule / getStatus / listModules      // already covered by the C ABI here
```

**What that means for this addon.** It already links `liblogos_core` and ships
`liblogos_protocol`; the missing piece is the C++ SDK's `LogosAPI` /
`LogosProviderObject`, and an implementation of the two methods above. The
addon then hands JS a real `call(module, method, args)` — no daemon, no
subprocess, no second copy of the runtime in the AppImage.

It is C++ work, and it is not an "import": `invokeRemoteMethod` is a
`LogosAPIClient` method over QRemoteObjects, so the invocation path cannot be
lifted into koffi. But it is a known-good design with a reference
implementation to follow, which is what makes it the endgoal rather than a
gamble.

**Confirm with the CLI first.** Before writing any of it, `make
probe-core-service` should show a JS consumer driving a module through a real
`logosctl` daemon's `core_service` over TCP. That validates the whole
assumption — gateway reachable, token accepted, `callModuleMethod` proxying —
at the cost of one config file. If it fails there, hosting the same gateway
in-process will not fare better, and that is worth knowing before committing to
the C++.

**Status of that confirmation: OBTAINED — the gateway route works.**

A JS client called a real method on `delivery_module` through `core_service`
over plain TCP:

```
core_service.getMethods() -> 16 methods
  loadModule, callModuleMethod, watchModuleEvents, getStatus, …

getStatus() -> {"daemon":{"pid":…,"status":"running"},"modules":[…]}

callModuleMethod(delivery_module, getAvailableConfigs) ->
  {"method":"getAvailableConfigs","module":"delivery_module",
   "result":{"error":"Context not initialized","success":false,"value":null},
   "status":"ok"}
```

`"status":"ok"` is the RPC round-trip succeeding. `"Context not initialized"` is
**delivery_module's own answer** — it wants `createNode()` before
`getAvailableConfigs()` means anything. That is the module talking, which is the
whole point.

**What made it work**, after an earlier run reported `0 methods` and no answer:

- **A fresh token.** `~/.logosctl/client/auto.json` is rewritten on every daemon
  boot. The failing run used one from a previous boot. A stale token does not
  produce an auth error — the call simply never answers, which looks exactly
  like the plain-transport hang and is why it was misread as one.
- **TCP-only transports.** Listing `local` and `tcp` together validates, but the
  daemon then dies silently mid-startup (log stops after capability_module, no
  ports, no socket). TCP alone binds both ports and stays up. The cost is that
  `logosctl`'s own client dials the local endpoint and reports `NO_DAEMON`
  while this config is installed.
- **Modules installed into the daemon's own store.** `logosctl package install
  --file <pkg>/*.lgx`, then `logosctl module load delivery_module`, which pulls
  in `lez_core`, `liblogos_lez_rln_module` and `liblogos_rln_module` by itself.
  A module the daemon has not loaded answers `MODULE_NOT_LOADED` — a structured
  reply, so even that failure proves the proxy path.

Repro: `make probe-core-service`, or the commands under "Picking that up".

Two things still worth understanding:

- The transport list *replaces* the default rather than adding to it, so a
  `tcp`-only config leaves `logosctl`'s own client unable to find its daemon
  (`NO_DAEMON: no local endpoint at /tmp/logos_core_service_<instance>`).
  Listing `local` and `tcp` together is accepted by the validator (the
  protocol name is `local`, not `local_socket`), but the daemon then failed to
  come up at all — no ports, no socket. Its log
  (`~/.logosctl/logs/daemon_<timestamp>.log`) stops mid-startup with no error:

  ```
  [info] Inter-module access enforcement is OFF (no access policy set)
  [info] [logos] Granting host services to 'capability_module': …
  [out]  [capability_module] … Granting host services to capability_module: …
  ```

  …and nothing after. A tcp-only config *does* bind both ports, so the
  two-transports-per-module case is the thing that breaks. **This is the first
  thing to debug.**
- Whether the SDK needs `LOGOS_INSTANCE_ID` set. `client.cpp` sets it for
  LocalSocket dialing and notes TCP clients do not need it; that is worth
  re-reading if the above is fixed and calls still hang.

### Picking that up

Everything needed is in the tree. `logosctl` is built at `./logosctl/bin/logosctl`
(from `nix build ~/src/logos-co/logos-logoscore-cli#ctl`), and
`scripts/daemon-node.yaml` is the daemon config.

```bash
./logosctl/bin/logosctl daemon config set scripts/daemon-node.yaml
./logosctl/bin/logosctl daemon start          # watch this: it has been dying silently
./logosctl/bin/logosctl daemon status         # 4 modules loaded when healthy
ss -ltn | grep -E ':700[12]'                  # core_service 7001, capability 7002

# the token the daemon issues itself, which the JS client needs
cat ~/.logosctl/client/auto.json              # -> .token

PROBE_TOKEN=<that token> nix develop --no-write-lock-file \
  ~/src/logos-co/logos-liblogos -c node scripts/probe-core-service.js
```

`scripts/probe-core-service.js` connects as a JS consumer, calls `getStatus()`
(does the gateway answer at all?), then
`callModuleMethod('delivery_module', 'getAvailableConfigs', [])` (does the proxy
work?). Both currently fail at the first step.

Useful details already paid for:

- The daemon session lives in `~/.logosctl/`: `client/auto.json` (token,
  rewritten each boot), `client/config.yaml`, `daemon/config.yaml`, `logs/`.
- `insecure_tcp: true` is required for plaintext TCP; the daemon refuses
  plaintext listeners otherwise.
- Transport protocol names are `local`, `tcp`, `tcp_ssl` — the validator says so
  by name when wrong, which is the fastest way to check any config key.
- `logosctl daemon config set` validates through the daemon's own loader before
  writing, so a rejected document never lands.

## Also worth knowing

- `loadModule` blocks the main thread, and so would a synchronous `createNode`.
  A helper process gets more attractive once the app is doing something
  continuous.
- `configureRln(QString)` and `rlnBridgeEnable()` exist, and the keystore now
  works (0.1.0 sets the persistence path), but no membership is registered.
- The probes are kept as Makefile targets deliberately: when the upstream gap
  closes, `make probe-sdk` is the one-command check for whether it did.
