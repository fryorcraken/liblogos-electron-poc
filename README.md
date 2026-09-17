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

**Both work.**

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

- **Qt and Chromium coexist in-process.** No symbol collision, no event-loop
  deadlock, no helper process needed.
- **The AppImage is self-contained**, 314 MB, and brings up the real delivery
  module with its Waku/RLN dependency chain.

### What "loaded" does and does not mean

`logos_core.h` defines a loaded module as one whose **plugin has loaded in its
host process** — not one that is doing any work. That is exactly what this PoC
shows, and it is worth being precise about the gap:

| Demonstrated | Not demonstrated |
| --- | --- |
| The plugin loads; `DeliveryModuleImpl` constructs | No Waku node is started |
| The dependency graph resolves and loads in order | No peers, no connections, no messages |
| Each module publishes its API on a transport | No module method is ever called |
| RLN creates and unlocks a keystore | No membership is registered |

**No delivery API call is made.** This addon binds only the lifecycle functions
in `logos_core.h`; calling into a module is a separate interface. The module's
own surface is substantial and entirely untouched here:

```
createNode(QString)              getAvailableConfigs()    getNodeInfo(QString)
channelCreate(...)               channelSend(...)         send(QString,QByteArray)
storeQuery(...)                  subscribe / unsubscribe  configureRln(QString)
stop()

signals: nodeStarted(bool,QString,int)  connectionStateChanged(QString,int)
         messageReceived(...)           channelMessageReceived(...)
```

`createNode()` is what would actually start the Waku node. Because none of this
is called, the module loads and then sits idle — which is also why the log stops
after bring-up rather than showing continuous activity.

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
2. `src/main.js` (Electron main) owns the runtime and exposes one action to the
   renderer over IPC. The renderer never sees native code: `contextIsolation`
   on, `nodeIntegration` off.
3. `scripts/bundle-runtime.js` collects the runtime into a relocatable tree, and
   electron-builder packs that into the AppImage.

The UI is one button. This is a packaging and embedding PoC, not a module
browser.

## Layout

```
src/addon.cc               N-API bindings + QCoreApplication
src/index.js               addon loading (incl. the asar.unpacked path fix)
src/main.js                Electron main: owns the runtime, IPC, headless self-test
src/preload.js             contextBridge surface
src/renderer/              the one-button UI
scripts/gyp-config.js      resolves liblogos + Qt build flags for binding.gyp
scripts/bundle-runtime.js  the relocatable runtime bundle (rpath rewriting)
scripts/smoke.js           drives the addon under plain Node
scripts/electron-smoke.js  drives it inside Electron, headless
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

# 3. Install them, then build.
npm ci --ignore-scripts
make modules           # lgpm install every .lgx into ./modules
make appimage          # -> dist/liblogos-electron-poc-0.1.0-x86_64.AppImage
make verify-appimage   # prove the packaged app starts delivery
```

Other targets: `make smoke` (plain Node), `make verify` (headless Electron),
`make run` (the app). All of them run inside liblogos' dev shell — see below for
why that is not optional. If your liblogos checkout is elsewhere:

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

A real app would put the runtime on its own thread owning a Qt event loop, or in
a helper process. Neither is needed to demonstrate that the API works.

### Two ABIs, two builds

Electron embeds its own Node/V8 ABI, so an addon built for the system Node will
not load in Electron. Hence `make build` (plain Node, for `make smoke`) and
`make build-electron` (everything else), writing to the same path; the targets
depend on the right one so they cannot drift.

## Next: actually starting a node (0.2.0)

Driving the module does not need more C++. `logos-js-sdk` is a **Qt-free koffi
wrapper** over the `lp_*` C ABI in `liblogos_protocol` — which this bundle
already ships — so it talks to a module from plain Node:

```js
const { LogosClient, tcp } = require('logos-js-sdk');
const logos = new LogosClient('electron_poc', { transport: tcp('127.0.0.1', 6001) });
const delivery = logos.module('delivery_module');
await delivery.call('createNode', configJson);
delivery.on('nodeStarted', (...) => …);
```

The one piece of plumbing needed is a transport the SDK can reach: modules here
bind only the default LocalSocket, so `logos_core_set_module_transports()` (also
in `logos_core.h`, also unbound so far) has to give `delivery_module` a TCP
transport before it is loaded.

That would turn "loads" into "runs": a real Waku node, `nodeStarted` and
`connectionStateChanged` arriving continuously, and a log that keeps moving
instead of stopping once bring-up finishes.

## CI

`.github/workflows/ci.yml` builds liblogos and every module through Nix, runs
the headless verification, builds the AppImage, and uploads it as an artifact.
Pushing a `v*` tag additionally publishes it as a release asset.
