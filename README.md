# liblogos-electron-poc

A **proof of concept**: an x86_64 **AppImage** containing an
[Electron](https://electronjs.org) app that brings up the
[Logos](https://github.com/logos-co/logos-liblogos) `delivery` module through
`liblogos_core`'s C ABI.

This is a **packaging and embedding** PoC. It proves the module and its whole
dependency chain load inside a shipped app; it does not drive the module's own
API — see [What "loaded" does and does not mean](#what-loaded-does-and-does-not-mean).

Companion to [`liblogos-rust-poc`](../liblogos-rust-poc), which embeds the same
runtime in a Rust CLI. Same question — *can a standalone app in a language other
than C++ embed the Logos runtime?* — with two harder follow-ups: the host is
**Electron**, so Qt has to coexist with Chromium in one process; and the result
has to **ship as a single file** that runs on a machine with no Nix.

## Result

**Both work, and the module now actually runs.**

0.1.0 proved the packaging: the module and its whole dependency chain load
inside a shipped app. 0.2.0 closes the gap it left — the app drives the module's
own API, so a real Waku node starts and stays connected.

```
$ make verify-appimage        # the packaged AppImage, outside any dev shell

logos_host:  /tmp/appimage_extracted_.../resources/runtime/bin/logos_host
[logos] Module loaded: capability_module
known: liblogos_lez_rln_module, liblogos_rln_module, lez_core, delivery_module, capability_module
[logos] Module loaded: lez_core
[logos] Module loaded: liblogos_lez_rln_module
[logos] Module loaded: liblogos_rln_module
[logos] [delivery_module] DeliveryModuleImpl: Initializing...
[logos] Module loaded: delivery_module
loadModule(delivery_module) -> true in 59 ms

PASS: delivery_module loaded from the packaged app
```

That runs the built AppImage with `LD_LIBRARY_PATH` unset and no `nix develop`
anywhere — the app resolves Qt, `liblogos_core`, `logos_host` and all five
modules entirely through its own bundled, `$ORIGIN`-relative libraries.

And the 0.2.0 half, which is a different mechanism (see
[Driving the module](#driving-the-module-020)):

```
$ make verify-node            # the app's own IPC handler, inside Electron

loading delivery_module…
{"dependencies_loaded":["liblogos_rln_module","lez_core","liblogos_lez_rln_module"],
 "module":"delivery_module","status":"ok","version":"0.2.1"}
watching: connectionStateChanged, messageReceived, messageSent, messageError, messagePropagated

createNode({"mode":"Core","preset":"logos.test"})
  createNode -> {"error":null,"success":true,"value":null}
start() — bringing the Waku node up
  start -> {"error":null,"success":true,"value":null}

[event] connectionStateChanged ["Connected",1789652780800796000]

PASS: a Waku node is running and delivery_module is emitting
```

- **Qt and Chromium coexist in-process.** No symbol collision, no event-loop
  deadlock, no helper process needed.
- **The AppImage is self-contained**, 366 MB, and brings up the real delivery
  module with its Waku/RLN dependency chain.
- **A Waku node actually runs.** `createNode()` and `start()` both return
  success, and the node reaches `Connected` against the `logos.test` network.

### What each release demonstrates

`logos_core.h` defines a loaded module as one whose **plugin has loaded in its
host process** — not one that is doing any work. 0.1.0 shows exactly that and no
more; 0.2.0 shows the module working. They are separate mechanisms, so it is
worth being precise about which claim rests on which:

| | 0.1.0 — the addon, in-process | 0.2.0 — the gateway, via a daemon |
| --- | --- | --- |
| Mechanism | `liblogos_core`'s C ABI from an N-API addon | `logosctl` daemon's `core_service`, over loopback TCP |
| The plugin loads; `DeliveryModuleImpl` constructs | yes | yes |
| The dependency graph resolves and loads in order | yes | yes |
| RLN creates and unlocks a keystore | yes | yes |
| A module method is called | **no** | **yes** — `createNode`, `start`, `getAvailableConfigs` |
| A Waku node is started | **no** | **yes** — `start()` returns success |
| Peers are connected | **no** | **yes** — `connectionStateChanged` reaches `Connected` |
| The log keeps moving after bring-up | **no** | **yes** — module events stream into the pane |

**Still not demonstrated, in either.** No message is sent or received: `send()`
and `subscribe()` are reachable through the same gateway call but nothing here
exercises them, so `messageSent` / `messageReceived` have never fired in a run.
No RLN membership is registered — the keystore is created and unlocked but
empty, which is why the `logos.test` preset is used rather than the
RLN-protected `twn`.

The module's surface, for reference — everything on the first two lines is
reachable through `callModuleMethod` today:

```
createNode(QString)              getAvailableConfigs()    getNodeInfo(QString)
send(QString,QString)            subscribe / unsubscribe  configureRln(QString)
start()                          stop()

events: connectionStateChanged(status, timestamp)
        messageReceived(hash, contentTopic, base64Payload, timestamp)
        messageSent / messageError / messagePropagated
```

Note there is **no `nodeStarted` event**, despite what an earlier draft of this
file claimed. `createNode()` and `start()` are synchronous calls returning a
bool, so "the node started" is their return value; the continuous traffic comes
from `connectionStateChanged` as peers come and go.

Run with `LOGOS_LOG_LEVEL=debug` (the default here), the log does show each
module coming up properly — publishing its surface and becoming reachable:

```
[delivery_module] RemoteTransportHost: Created registry host with URL:
  "local:logos_delivery_module_65f10ec52244"
[delivery_module] LogosAPIProvider: successfully published "delivery_module"
[liblogos_rln_module] keystore auto-unlock at init: created (0 membership(s))
```

That keystore line is the effect of `logos_core_set_persistence_base_path()`,
which the app points at a directory under `userData`. Without it the same module
reports `host provided no instance_persistence_path — keystore ops will fail`.

## What it does

1. `src/addon.cc` wraps the C ABI (`logos_core.h`) as an N-API addon, and
   constructs the `QCoreApplication` liblogos requires. No Rust, no FFI shim —
   the binding is C++, so it creates the Qt application object directly.
2. `src/daemon.js` spawns and supervises a `logosctl` daemon; `src/gateway.js`
   drives `delivery_module` through that daemon's `core_service` gateway with
   `logos-js-sdk`.
3. `src/main.js` (Electron main) owns both and exposes them to the renderer over
   IPC. The renderer never sees native code: `contextIsolation` on,
   `nodeIntegration` off.
4. `scripts/bundle-runtime.js` collects the runtime into a relocatable tree, and
   electron-builder packs that into the AppImage.

The UI is two buttons — start a node (0.2.0), or load the module only (0.1.0).
This is a packaging and embedding PoC, not a module browser.

## Layout

```
src/addon.cc               N-API bindings + QCoreApplication
src/index.js               addon loading (incl. the asar.unpacked path fix)
src/main.js                Electron main: owns the runtime, IPC, headless self-test
src/daemon.js              spawns/supervises the logosctl daemon
src/gateway.js             drives the module through core_service (logos-js-sdk)
src/preload.js             contextBridge surface
src/renderer/              the two-button UI
scripts/gyp-config.js      resolves liblogos + Qt build flags for binding.gyp
scripts/bundle-runtime.js  the relocatable runtime bundle (rpath rewriting)
scripts/smoke.js           drives the addon under plain Node
scripts/electron-smoke.js  drives it inside Electron, headless (0.1.0)
scripts/probe-node.js      daemon + gateway under plain Node (0.2.0)
scripts/electron-node-smoke.js  the same inside Electron, via the real IPC handler
electron-builder.yml       AppImage packaging
```

## Build

Prerequisites: [Nix](https://nixos.org) with flakes, Node 20+.

```bash
# 1. liblogos itself.
nix build 'github:logos-co/logos-liblogos' -o ./liblogos

# 2. The package manager and every module in delivery's dependency chain.
nix build 'github:logos-co/logos-package-manager#cli' -o lgpm
nix build 'github:logos-co/logos-capability-module#lgx' -o cap-lgx
nix build 'github:logos-co/logos-delivery-module#lgx' -o delivery-lgx
nix build 'github:logos-co/logos-delivery-module#liblogos_rln_module-lgx' -o rln-lgx
nix build 'github:logos-co/logos-delivery-module#liblogos_lez_rln_module-lgx' -o lez-rln-lgx
nix build 'github:logos-co/logos-delivery-module#lez_core-lgx' -o lez-core-lgx

# 3. The logosctl daemon, which 0.2.0 runs beside the app.
nix build 'github:logos-co/logos-logoscore-cli#ctl' -o logosctl

# 4. Install them, then build.
npm ci --ignore-scripts
make modules           # lgpm install every .lgx into ./modules
make appimage          # -> dist/liblogos-electron-poc-0.2.0-x86_64.AppImage
make verify-appimage   # prove the packaged app starts delivery
```

Other targets: `make smoke` (plain Node), `make verify` (headless Electron,
0.1.0), `make verify-node` (headless Electron, 0.2.0 — starts a real node),
`make probe-node` (the same under plain Node), `make run` (the app). All of them
run inside liblogos' dev shell — see below for why that is not optional. If your
liblogos checkout is elsewhere:

```bash
make appimage LIBLOGOS_FLAKE=/path/to/logos-liblogos
```

## Findings

### The Qt version trap

**Everything must be built and run against the Qt that liblogos was built
against.** Linking the addon against a distro Qt (6.10.3 in `/usr/lib64` here)
while liblogos uses the Qt its flake pins (6.9.2) compiles and links fine, then
fails at `dlopen`:

```
libQt6Core.so.6: version `Qt_6_PRIVATE_API' not found
  (required by .../libQt6RemoteObjects.so.6)
```

liblogos' Qt dependencies reach for private symbols only their matching Qt
exports. Hence every `make` target wraps its command in `nix develop`.

### Nix rpaths do not survive packaging

Everything Nix builds names its dependencies by absolute `/nix/store` path,
recorded in each ELF file's `RUNPATH`. Copying those files into an AppImage
produces a bundle that cannot resolve a single library. `bundle-runtime.js`
therefore walks the transitive `NEEDED` closure (61 libraries), copies each one
into a flat `lib/`, and rewrites every `RUNPATH` to be `$ORIGIN`-relative,
including the module plugins' own versioned siblings (`libpq.so.5.17` and
friends, which are easy to miss — they are not entry points).

### libstdc++ must be bundled; glibc must not

The usual AppImage advice is to bundle neither. But `logos_host` is a **separate
process** spawned by core, inheriting none of the app's library paths, and Nix
builds it against a much newer GCC than a distro ships. Without a bundled
`libstdc++.so.6` every module load fails:

```
logos_host: error while loading shared libraries: libstdc++.so.6:
  cannot open shared object file
[logos] Failed to load module capability_module: the module process exited with code 127
```

`libstdc++` and `libgcc_s` are backward-compatible, so bundling them is safe.
glibc is not, and must still come from the host — its loader is the host's.

### The addon cannot live inside app.asar

`dlopen` cannot read from an asar archive, so the addon is `asarUnpack`ed and
`src/index.js` rewrites `app.asar/` to `app.asar.unpacked/` in the path. Its
rpath also has to point at `resources/runtime/lib` — three levels up from where
electron-builder puts it — which `bundle-runtime.js` patches in place.

### electron-builder must not rebuild the addon

`npmRebuild: false`. Its `@electron/rebuild` step runs node-gyp outside the dev
shell, where `LOGOS_LIBLOGOS_ROOT` is unset and the wrong Qt is on the
pkg-config path — so it either fails outright or silently produces a binary
linked against the system Qt.

### Core's log needs an fd-level capture, not a JS one

liblogos logs through spdlog, and the module hosts are separate processes whose
output core forwards — all of it written straight to file descriptors 1 and 2.
None of it passes through Node, so wrapping `process.stdout.write` sees nothing,
and in a packaged app the user sees nothing at all.

`startLogCapture` in `src/addon.cc` therefore redirects both fds into a
`pipe(2)` and reads them back on a thread, forwarding each chunk to JS through a
`ThreadSafeFunction`. The real stdout is `dup`'d first and still written to, so
`make verify` and CI keep their output while the UI gets a copy.

It must be a **`NonBlockingCall`**. `BlockingCall` waits for the main thread to
drain the queue, and the main thread is blocked inside `loadModule()` for the
whole bring-up — precisely when core does most of its logging. The reader thread
stalls, the pipe fills, and core's own writes then block behind it: a deadlock
that silently takes the terminal output with it. Dropping a chunk under pressure
is the right trade for a log view.

### loadModule blocks the main process

`logos_core_load_module` blocks until the module's host reports the plugin
loaded, and `logos_core.h` is explicit that core's outbound calls run on the
thread that called `logos_core_start()`. Every binding here is therefore
synchronous and main-thread-only, so **a module bring-up freezes the UI** — 59 ms
for delivery's whole chain, but a heavier module would be visible.

**Not by moving the runtime to its own Qt thread**, which this README used to
suggest. That was tested for 0.3.0 and it hangs: Qt's socket notifiers stay
affined to the thread that created them, so a dedicated `QEventLoop::exec()`
never services them. The working answers are an async worker off the JS thread,
or a helper process. See [`docs/0.3.0-inventory.md`](./docs/0.3.0-inventory.md).

### Two ABIs, two builds

Electron embeds its own Node/V8 ABI, so an addon built for the system Node will
not load in Electron. Hence `make build` (plain Node, for `make smoke`) and
`make build-electron` (everything else), writing to the same path; the targets
depend on the right one so they cannot drift.

## Driving the module (0.2.0)

The app runs a `logosctl` daemon beside itself and talks to that daemon's
`core_service` — a gateway registered in-process by the daemon, which proxies
module calls through a real C++ `TokenManager`. `logos-js-sdk` connects to it
over loopback TCP as an ordinary consumer.

```
Electron main ──spawn──> logosctl daemon ──loads──> delivery_module
      │                        │
      └──logos-js-sdk, TCP────> core_service
              callModuleMethod(delivery_module, createNode, [cfg])
              watchModuleEvents(delivery_module, connectionStateChanged)
```

`src/daemon.js` supervises the daemon; `src/gateway.js` drives the module
through it. Reproduce headlessly with `make probe-node` (plain Node) or
`make verify-node` (inside Electron, driving the app's own IPC handler).

### Why a daemon, and what it is *not* evidence of

Calling a module from **`logos-js-sdk`** does not work, and the cause is pinned
down in [`NEXT.md`](./NEXT.md): `capability_module` publishes **0 methods** over
a plain transport, so the SDK's per-target token lookup dials a surface with
nothing behind it and waits forever. Giving it its own transport, calling as the
trusted `core_service` identity, and both `saveToken` and `informToken` were all
tried; none helps.

**That is a limitation of Qt-free clients specifically, not of this process.**
An in-process C++ caller — which the addon already is — can invoke a module
directly with `getClient()` + `invokeRemoteMethod()`: no daemon, no gateway, no
TCP port, no token. It speaks the default LocalSocket/QtRO transport, the one
every module already publishes on and the one `capability_module` *does* publish
its handshake on. That was measured, not reasoned (`make exp-call`); see
[`docs/0.3.0-inventory.md`](./docs/0.3.0-inventory.md).

So the daemon is not here because in-process calls are impossible. It is here
because 0.2.0 reached the working end state through the JS SDK, which needs a
gateway to talk to.

### What it costs

Honestly accounted for, because 0.3.0 exists to remove all of it:

- **A second process.** The daemon loads its own copy of `delivery_module`, so
  the module is up twice if the 0.1.0 button is also used.
- **`logosctl` in the AppImage**, with its own `lib/`, `modules/` and
  `modules-pkg/` trees — it is a Nix wrapper script over a dynamically linked
  binary, not the statically linked one it appears to be.
- **A daemon lifecycle the app has to manage**: start it, wait for the port,
  read the token *after* it boots, and stop it on every exit path.

0.3.0 replaces all three by calling modules from the addon directly.

## CI

`.github/workflows/ci.yml` builds liblogos and every module through Nix, runs
the headless verification, builds the AppImage, and uploads it as an artifact.
Pushing a `v*` tag additionally publishes it as a release asset.

**It does not yet build `logosctl`.** `bundle-runtime.js` skips the daemon when
`./logosctl` is absent rather than failing, so CI still produces a working
0.1.0-equivalent AppImage — but one whose "Start Waku node" button reports
`logosctl not found`. Adding `nix build 'github:logos-co/logos-logoscore-cli#ctl'
-o logosctl` to the workflow is what would close that, and `make verify-node` is
the check for whether it worked.
