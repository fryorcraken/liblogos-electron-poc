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

**All three work.** The app has a button for each, and each proves something
different:

| | What it proves |
| --- | --- |
| **Load only** (0.1.0) | The module and its whole dependency chain load inside a shipped app, on a machine with no Nix. It cannot call the module. |
| **via logosctl** (0.2.0) | A daemon beside the app drives the module through its `core_service` gateway — the route a Qt-free consumer has to take. A real Waku node starts and reaches `Connected`. |
| **in-process** (0.3.0) | The addon calls the module itself. Same node, no daemon, no gateway, no transport, no token — but it needs Qt C++. |

If you only read one thing, read
[What has to be FFI-wrapped](#what-has-to-be-ffi-wrapped-and-what-is-only-glue):
the three routes exist to show that **only the last one requires C++**.

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

And 0.3.0, which reaches the same place with no daemon at all — the addon
calling the module itself (see [In-process](#in-process-030)):

```
$ make verify-inproc          # the shipped addon, inside Electron

watchModule(delivery_module, *) -> id=1
createNode({"mode":"Core","preset":"logos.test"}) -> success:true
start() -> success:true

EVENT connectionStateChanged: ["PartiallyConnected",...]
EVENT nodeStarted: [true,"",...]
EVENT connectionStateChanged: ["Connected",...]
renderer executeJavaScript(1+1) -> 2

PASS: a Waku node started in-process inside Electron, Chromium responsive
```

That last line before the PASS is the point of the check: it executes JavaScript
in the renderer *after* the node is up, so a node that ran by wedging the UI
would fail it.

- **Qt and Chromium coexist in-process.** No symbol collision, no event-loop
  deadlock, no helper process needed — and with Qt's loop pumped alongside
  Chromium's, which 0.1.0 never had to do.
- **The AppImage is self-contained**, 427 MB with the daemon bundled, and brings
  up the real delivery module with its Waku/RLN dependency chain.
- **A Waku node actually runs**, by two independent routes. `createNode()` and
  `start()` both return success, and the node reaches `Connected` against the
  `logos.test` network.
- **In-process calling costs nothing in size.** Every library it links was
  already bundled for the C ABI.

### What each release demonstrates

`logos_core.h` defines a loaded module as one whose **plugin has loaded in its
host process** — not one that is doing any work. The app keeps all three routes
side by side, one button each, because each proves something the others do not:

| | Load only (0.1.0) | via logosctl (0.2.0) | in-process (0.3.0) |
| --- | --- | --- | --- |
| Mechanism | `liblogos_core`'s C ABI | `logosctl` daemon's `core_service`, over loopback TCP | `LogosAPIClient` from the addon, default LocalSocket/QtRO |
| Needs C++? | no — plain C, bindable anywhere | no — the JS SDK is Qt-free koffi | **yes** — `LogosAPI` is a `QObject` |
| Second process? | no | **yes** — a daemon beside the app | no |
| The plugin loads; `DeliveryModuleImpl` constructs | yes | yes | yes |
| The dependency graph resolves in order | yes | yes | yes |
| RLN creates and unlocks a keystore | yes | yes | yes |
| A module method is called | **no** | yes — `createNode`, `start` | yes — `createNode`, `start` |
| A Waku node is started | **no** | yes | yes |
| Peers are connected | **no** | yes — reaches `Connected` | yes — reaches `Connected` |
| The check | `make verify-appimage` | `make verify-node` | `make verify-inproc` |

The first row is the finding: **only calling a module in-process requires C++**,
because `LogosAPI`/`LogosAPIClient` are `QObject`s with no C ABI. Loading
modules and consuming them from another process are both plain C. See
[What has to be FFI-wrapped](#what-has-to-be-ffi-wrapped-and-what-is-only-glue).

**Still not demonstrated, by any route.** No message is sent or received:
`send()` and `subscribe()` are reachable but nothing here exercises them, so
`messageSent` / `messageReceived` have never fired in a run. No RLN membership
is registered — the keystore is created and unlocked but empty, which is why the
`logos.test` preset is used rather than the RLN-protected `twn`.

The module's own surface, for reference:

```
createNode(QString)              getAvailableConfigs()    getNodeInfo(QString)
send(QString,QString)            subscribe / unsubscribe  configureRln(QString)
start()                          stop()

events:  connectionStateChanged  messageReceived  messageSent
         messageError            messagePropagated
```

The events are NOT one Qt signal each: the module declares a single
`eventResponse(QString eventName, QVariantList data)` and puts the name in the
first argument (`delivery_module_plugin.h:23-51`), with every payload element a
`QString`. An earlier revision of this list said `nodeStarted(bool,QString,int)`
and `connectionStateChanged(QString,int)`, which was wrong on both counts.

`nodeStarted` is a genuine oddity worth keeping: it appears nowhere in
`logos-delivery-module`'s source, and is nevertheless delivered at runtime —
`make exp-event` catches it, arriving from the liblogosdelivery FFI layer rather
than the plugin's own mapping. Subscribing with an empty event name (the
wildcard) is therefore the only way to be sure of seeing everything.

`createNode()` is what actually starts the Waku node, and 0.3.0 calls it —
which is why the log no longer stops after bring-up. It takes a JSON *document*
of `WakuNodeConf` fields, not a config name; a `preset` is what gives the node
somebody to dial, where `{}` starts one that sits silent:

```json
{"mode": "Core", "preset": "logos.test"}
```

Reaching it from OUTSIDE the process needs a gateway: a Qt-free consumer cannot
speak the default LocalSocket/QtRO transport, and `capability_module` publishes
nothing over a plain one, so the token handshake never completes and calls hang.
0.2.0 solves that by talking to a `logosctl` daemon's `core_service`, which does
the invocation in-process on its side. 0.3.0 skips the intermediary entirely,
because the addon is itself a Qt participant on the bus the modules already use.

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

## What has to be FFI-wrapped, and what is only glue

The question this PoC exists to answer, for anyone sizing the same work in
another language. Every file and line below is in this repo and runs.

### The dividing line

Two of the three things an app needs are **plain C** and bind from any language.
The third is **Qt C++** and does not.

| What you need | Interface | Bindable without C++? |
| --- | --- | --- |
| Start the runtime, load modules | `logos_core_*` C ABI | **yes** — plain C |
| Consume a module from another process | `lp_*` C ABI in `liblogos_protocol` | **yes** — [logos-js-sdk](https://github.com/logos-co/logos-js-sdk) binds it with koffi, no compiler |
| **Call a module in-process** | `LogosAPI` / `LogosAPIClient`, C++ | **no** — both are `QObject`s with no C ABI |

That third row is the whole finding. It is why this repo contains a compiled
addon rather than a `koffi` script, and it is the one thing a Logos dev kit
would have to change to make module-calling reachable from Rust, Go or Python.

### 1. The FFI wrapper — `src/addon.cc` (629 lines)

The only C++ in the project. Two distinct halves:

**(a) The C ABI half — mechanical, would be identical in any language.** Each of
these is a few lines forwarding to a `logos_core_*` call:

| JS | C ABI | Line |
| --- | --- | --- |
| `init()` | `logos_core_init` | [`addon.cc:139`](src/addon.cc#L139) |
| `addModulesDir()` | `logos_core_add_modules_dir` | [`:157`](src/addon.cc#L157) |
| `setPersistenceBasePath()` | `logos_core_set_persistence_base_path` | [`:168`](src/addon.cc#L168) |
| `start()` / `cleanup()` | `logos_core_start` / `_cleanup` | [`:193`](src/addon.cc#L193), [`:414`](src/addon.cc#L414) |
| `loadModule()` | `logos_core_load_module` | [`:444`](src/addon.cc#L444) |
| `knownModules()` / `loadedModules()` | `logos_core_get_*_modules` | [`:475`](src/addon.cc#L475), [`:481`](src/addon.cc#L481) |

[`liblogos-rust-poc`](../liblogos-rust-poc) binds this same surface in Rust, so
none of it is Node-specific.

**(b) The Qt C++ half — the part that cannot be FFI'd:**

| Piece | Why C++ is unavoidable | Line |
| --- | --- | --- |
| `QCoreApplication` construction | liblogos requires one before `start()`; no C API creates it | [`addon.cc:55`](src/addon.cc#L55) |
| `callModule()` → `LogosAPIClient::invokeRemoteMethod` | `LogosAPIClient` is a `QObject`; this is the irreducible core | [`:264`](src/addon.cc#L264) (`CallModuleWorker`), [`:323`](src/addon.cc#L323) |
| `watchModule()` → `onEventWhenAvailable` | Qt signal delivery into a `ThreadSafeFunction` | [`:364`](src/addon.cc#L364) |
| Qt event-loop pump | `processEvents()` — without it `callModule` silently waits out its 20 s timeout | [`:232`](src/addon.cc#L232) |

**~190 of the 629 lines are this half.** That is the real cost of the gap.

### 2. The glue — JavaScript, no compiler

Everything else is ordinary application code:

| File | Lines | Job |
| --- | --- | --- |
| [`src/index.js`](src/index.js) | 196 | Loads the `.node`, parses JSON, drives the pump as an unref'd `setInterval` |
| [`src/main.js`](src/main.js) | 333 | Electron main: owns the runtime, IPC handlers, headless self-test |
| [`src/daemon.js`](src/daemon.js) | 241 | 0.2.0 only: supervises a `logosctl` child process |
| [`src/gateway.js`](src/gateway.js) | 222 | 0.2.0 only: drives the module through `core_service` |
| [`src/preload.js`](src/preload.js) | 41 | `contextBridge` surface |

### 3. The build and packaging glue

Not FFI, but the part that actually took the longest — see
[Findings](#findings):

| File | Lines | Job |
| --- | --- | --- |
| [`binding.gyp`](binding.gyp) | 39 | node-gyp target; links `logos_core`, `logos_qt_host`, `logos_protocol`, Qt |
| [`scripts/gyp-config.js`](scripts/gyp-config.js) | 141 | Resolves liblogos + Qt flags (gyp cannot call pkg-config itself) |
| [`scripts/bundle-runtime.js`](scripts/bundle-runtime.js) | 244 | Walks the `NEEDED` closure, rewrites every `RUNPATH` to `$ORIGIN` |

`bundle-runtime.js` is the one to read if you are packaging Nix-built libraries
anywhere: every `.so` names its dependencies by absolute `/nix/store` path, so a
bundle that is merely copied resolves nothing.

### Summary for sizing the work

- **~190 lines of Qt C++** is the irreducible part, and only because
  `LogosAPI`/`LogosAPIClient` have no C ABI.
- **~440 lines of C++** are a mechanical C-ABI wrapper any language can replace.
- **~1,000 lines of JS** are glue with no compiler involved.
- **~420 lines of build/packaging** glue, mostly rpath surgery for Nix output.
- Adding in-process calling cost **zero AppImage size** — every library it links
  was already bundled.

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
make verify-appimage   # prove the packaged app loads delivery (0.1.0)
make verify-appimage-node  # prove the BUNDLED daemon works too (0.2.0)
```

`verify-appimage` never touches `logosctl`, so it would pass just as happily
with the daemon missing from the bundle or unable to find its Qt plugins —
which is exactly the failure that packaging a Nix-wrapped binary invites.
`verify-appimage-node` runs the bundled daemon out of the extracted AppImage
with `LD_LIBRARY_PATH` and `QT_PLUGIN_PATH` unset, which is the same
relocatability test the rest of the runtime already gets.

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
  read the token *after* it boots, and stop it on every exit path — including
  `app.exit()`, which does not fire `will-quit`. And `logosctl daemon stop`
  cannot stop this daemon: the CLI dials the local endpoint that the tcp-only
  config removes, so it reports `NO_DAEMON` while the daemon is running and
  holding both ports. The app signals the pid instead. A leaked daemon is not
  cosmetic — the next run cannot bind, and the orphan is invisible to the
  obvious way of checking.

0.3.0 removes all three by calling modules from the addon directly.

## In-process (0.3.0)

The addon calls `delivery_module` itself: `getClient()` then
`invokeRemoteMethod()`, over the **default LocalSocket/QtRO transport that every
module already publishes on and uses to talk to its peers**. No daemon, no
gateway, no TCP port, no token.

```js
await core.callModule('delivery_module', 'createNode', [NODE_CONFIG]);
await core.callModule('delivery_module', 'start', []);
core.watchModule('delivery_module', '', onEvent);   // '' = every event
```

`make verify-inproc` is the check. `make exp-call` is the smaller experiment it
grew out of, and the one to re-run first if this ever stops working.

### Why this works when the JS SDK could not

The plain-transport limitation that forced 0.2.0's daemon applies to **Qt-free**
consumers. The addon is not one: it is a Qt participant in the same process,
speaking the transport the modules already use. That is the entire difference,
and it took a long time to see because the failure mode of the other route —
calls hanging rather than erroring — looks identical to a dozen other problems.

### What it needs, and what it costs

**~190 lines of Qt C++** in `src/addon.cc`, listed by line in
[the FFI section](#what-has-to-be-ffi-wrapped-and-what-is-only-glue). Four
pieces, each non-obvious:

- **`callModule` is a `Napi::AsyncWorker`** ([`addon.cc:264`](src/addon.cc#L264)).
  Not polish: `invokeRemoteMethod` blocks with a 20 s default timeout, and doing
  that on Electron's main thread freezes the window for the duration.
- **Qt's event loop must be pumped** ([`addon.cc:232`](src/addon.cc#L232),
  driven from [`index.js`](src/index.js)). A QtRO round trip only completes when
  the loop is serviced, and an unpumped `callModule` does not error — it waits
  out the full timeout. Inside Electron it happens to work unpumped, because
  Qt's glib dispatcher attaches to the `GMainContext` Chromium drives, but
  `QT_NO_GLIB=1` flips that to a hang. The pump is explicit so correctness does
  not rest on the coincidence.
- **A dedicated Qt thread does not work.** Socket notifiers stay affined to the
  thread that created them, so a `QEventLoop::exec()` on its own thread never
  services them. This README used to recommend exactly that.
- **Events subscribe with the wildcard** (`''`). A subscription *arms* on event
  names the module never emits, so "armed but silent" is indistinguishable from
  a typo — and the module only wires its event callback on `createNode`'s
  success path, so subscribing has to come first and still see nothing until
  then.

**Zero AppImage cost**: `liblogos_qt_host` and `liblogos_protocol` were already
bundled for the C ABI.

**The real trade** is the ABI. 0.1.0 bound only the C ABI, which was deliberate
insulation; this links the C++ host runtime, whose header carries a private-
layout warning. A liblogos bump can now break the addon at load time rather than
at compile time. `docs/0.3.0-inventory.md` §5.9 records that, along with what is
still untested: nothing has run longer than ~60 s, the 5 ms pump interval is
uncharacterised, and macOS and Windows are entirely unknown — the glib
dispatcher does not exist there, and on macOS both Chromium and Qt want
`NSApplication`'s run loop.

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
