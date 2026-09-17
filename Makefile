# Build and run targets for the PoC.
#
# These exist because every invocation needs the same three environment
# variables, and typing them at the prompt each time is both tedious and easy to
# get subtly wrong. Keeping them here makes the working invocation the
# documented one.
#
#   make build   compile the native addon
#   make smoke   drive the addon under plain Node (no Electron)
#   make run     launch the Electron app
#   make clean   remove build output

# The liblogos `nix build` result: include/ lib/ bin/. Override for a different
# checkout:  make build LOGOS_LIBLOGOS_ROOT=/path/to/result
LOGOS_LIBLOGOS_ROOT ?= $(CURDIR)/liblogos

# The module host binary core spawns per module. Without it, core comes up but
# every load fails, because it cannot start a host to load the plugin into.
export LOGOS_HOST_PATH = $(LOGOS_LIBLOGOS_ROOT)/bin/logos_host

# Qt needs a platform plugin. liblogos is headless, so under plain Node there is
# no display to bind and `offscreen` is the one that works. Electron is a
# different case — see the `run` target.
MODULES_DIR ?= $(CURDIR)/modules
MODULE ?= delivery_module

# EVERYTHING RUNS THROUGH THE DEV SHELL, and it is not optional.
#
# liblogos is built against the Qt its flake pins (6.9.2 here). Building or
# running against a DIFFERENT Qt — a distro's /usr/lib64 Qt 6.10, say — links
# and then fails at dlopen with:
#
#   libQt6Core.so.6: version `Qt_6_PRIVATE_API' not found
#     (required by .../libQt6RemoteObjects.so.6)
#
# because liblogos' own Qt dependencies reach for private symbols that only
# their matching Qt exports. One Qt, everywhere, is the whole requirement.
LIBLOGOS_FLAKE ?= $(HOME)/src/logos-co/logos-liblogos

# --no-write-lock-file: when LIBLOGOS_FLAKE is a github: URL (as it is in CI),
# the flake is read-only, and any lock entry Nix wants to refresh becomes a hard
# error — "cannot write modified lock file". Harmless for a local checkout.
SHELL_RUN = nix develop --no-write-lock-file $(LIBLOGOS_FLAKE) -c

# Electron embeds its own Node/V8 ABI, so a .node built for the system Node
# will not load in it ("was compiled against a different Node.js version").
# `build` targets plain Node for `make smoke`; `build-electron` targets Electron
# for `make run`. They overwrite the same output file, so whichever ran last
# wins — run the one matching what you are about to launch.
ELECTRON_VERSION = $(shell node -p "require('electron/package.json').version")
ELECTRON_GYP = npx node-gyp rebuild --target=$(ELECTRON_VERSION) \
	--dist-url=https://electronjs.org/headers

# Every .lgx that has to be installed for delivery_module to load. The chain is
# deeper than delivery's own manifest shows:
#   delivery_module -> liblogos_rln_module -> liblogos_lez_rln_module -> lez_core
# plus capability_module, which core brings up on its own at start().
LGX_DIRS = cap-lgx delivery-lgx rln-lgx lez-rln-lgx lez-core-lgx

# The same list minus cap-lgx, for the logosctl daemon: it has capability_module
# built in, so installing the package over it is unnecessary.
DAEMON_LGX_DIRS = lez-core-lgx lez-rln-lgx rln-lgx delivery-lgx

.PHONY: build build-electron smoke verify run bundle appimage modules probe-transport probe-sdk probe-core-service probe-node clean

build:
	$(SHELL_RUN) env LOGOS_LIBLOGOS_ROOT=$(LOGOS_LIBLOGOS_ROOT) npx node-gyp rebuild

build-electron:
	$(SHELL_RUN) env LOGOS_LIBLOGOS_ROOT=$(LOGOS_LIBLOGOS_ROOT) $(ELECTRON_GYP)

smoke: build
	$(SHELL_RUN) env QT_QPA_PLATFORM=offscreen node scripts/smoke.js $(MODULES_DIR) $(MODULE)

# Proves the binding survives inside Electron's main process, headlessly — the
# Qt/Chromium coexistence question, answered without a human clicking anything.
# ELECTRON_DISABLE_SANDBOX, not app.commandLine.appendSwitch('no-sandbox').
#
# The switch is applied too late: Chromium brings up its SUID sandbox helper
# before any line of the script runs, so it aborts with "The SUID sandbox helper
# binary was found, but is not configured correctly" regardless. The helper is
# not root-owned mode 4755 in a node_modules checkout on a CI runner, and
# unprivileged user namespaces are not guaranteed there either. The environment
# variable is read during that early startup, so it actually takes effect.
verify: build-electron
	$(SHELL_RUN) env ELECTRON_DISABLE_SANDBOX=1 npx electron scripts/electron-smoke.js $(MODULE)

# NOT offscreen: Electron owns the display connection, and Qt here is only
# driving module hosts, not drawing anything.
run: build-electron
	$(SHELL_RUN) npx electron .

# Collect the Logos runtime into a relocatable tree (see bundle-runtime.js).
# Needs patchelf, which comes from nixpkgs rather than the liblogos dev shell.
bundle: build-electron
	nix shell nixpkgs#patchelf -c $(SHELL_RUN) env \
		LOGOS_LIBLOGOS_ROOT=$(LOGOS_LIBLOGOS_ROOT) MODULES_DIR=$(MODULES_DIR) \
		node scripts/bundle-runtime.js $(CURDIR)/runtime-bundle

# The deliverable: an x86_64 AppImage with the runtime inside it.
#
# --publish never: on a tag, electron-builder decides on its own that it should
# publish to GitHub Releases, and fails the build for want of a token:
#
#   ⨯ GitHub Personal Access Token is not set, neither programmatically,
#     nor using env "GH_TOKEN"
#
# Publishing is the release step's job (softprops/action-gh-release), not the
# builder's. This target only ever builds.
appimage: bundle
	npx electron-builder --linux AppImage --x64 --publish never

# Runs the PACKAGED AppImage, deliberately OUTSIDE the nix dev shell and with an
# empty LD_LIBRARY_PATH. That is the whole point: if the bundle is truly
# relocatable, the app finds Qt, liblogos and every module through its own
# $ORIGIN rpaths alone. Any leftover /nix/store reference fails here.
APPIMAGE = dist/liblogos-electron-poc-$(shell node -p "require('./package.json').version")-x86_64.AppImage

# ELECTRON_DISABLE_SANDBOX for the same reason as `verify`: the --no-sandbox
# flag is read too late to stop Chromium's SUID helper from aborting on a runner
# where the helper is not root-owned 4755 and user namespaces are off. Both are
# passed — the flag is harmless, and the variable is what actually works.
verify-appimage:
	env -u LD_LIBRARY_PATH -u QT_PLUGIN_PATH LOGOS_SMOKE=1 \
		ELECTRON_DISABLE_SANDBOX=1 \
		$(APPIMAGE) --appimage-extract-and-run --no-sandbox

# Install every .lgx into ./modules. Safe to re-run; lgpm overwrites in place.
modules:
	mkdir -p modules
	for d in $(LGX_DIRS); do ./lgpm/bin/lgpm --modules-dir ./modules --allow-unsigned install --file $$d/*.lgx; done
	ls modules/

# Finds the transport JSON core accepts, by trying one and checking whether the
# module actually binds the port. See scripts/probe-transport.js.
probe-transport: build
	$(SHELL_RUN) env QT_QPA_PLATFORM=offscreen node scripts/probe-transport.js

# The next question: can logos-js-sdk actually call the module over that port?
probe-sdk: build
	$(SHELL_RUN) env QT_QPA_PLATFORM=offscreen node scripts/probe-sdk.js

# The one that matters: reach a module THROUGH the daemon's core_service gateway,
# which is how logosctl itself does it. Starts a daemon on plain TCP, installs
# the modules, then drives it from Node. See scripts/probe-core-service.js.
LOGOSCTL = ./logosctl/bin/logosctl

probe-core-service:
	env LOGOSCTL=$(LOGOSCTL) MODULE=$(MODULE) \
		DAEMON_LGX_DIRS="$(DAEMON_LGX_DIRS)" LIBLOGOS_FLAKE=$(LIBLOGOS_FLAKE) \
		bash scripts/probe-core-service.sh

# 0.2.0, headless: the app's OWN daemon and gateway modules (src/daemon.js,
# src/gateway.js) starting a real node and streaming its events. Same code the
# button drives, without Electron — so a failure here is a failure in the app,
# not in a script that merely resembles it.
probe-node:
	$(SHELL_RUN) env MODULE=$(MODULE) node scripts/probe-node.js

# --- 0.3.0 research: can the addon HOST core_service in-process? -------------
#
# EXPERIMENTAL, and deliberately kept out of `build`: these targets compile a
# SECOND addon (scripts/exp-provider/) that links liblogos_qt_host and
# liblogos_protocol on top of what the shipped addon uses. Nothing here touches
# src/addon.cc or binding.gyp, so a broken experiment cannot break the release.
#
# The question: publishing a provider object and serving RPC needs a LIVE Qt
# event loop, and src/addon.cc has never run one. See docs/0.3.0-inventory.md.
EXP_DIR = scripts/exp-provider

exp-provider:
	$(SHELL_RUN) env LOGOS_LIBLOGOS_ROOT=$(LOGOS_LIBLOGOS_ROOT) \
		npx node-gyp rebuild --directory=$(EXP_DIR)

exp-provider-electron:
	$(SHELL_RUN) env LOGOS_LIBLOGOS_ROOT=$(LOGOS_LIBLOGOS_ROOT) \
		npx node-gyp rebuild --directory=$(EXP_DIR) \
		--target=$(ELECTRON_VERSION) --dist-url=https://electronjs.org/headers

# Under plain Node first: if a published provider cannot answer HERE, Electron
# is not the variable. EXP_MODE selects how the Qt event loop is driven:
# none | pump | thread.
EXP_MODE ?= pump
EXP_PORT ?= 7401

exp-node: exp-provider
	$(SHELL_RUN) env QT_QPA_PLATFORM=offscreen EXP_MODE=$(EXP_MODE) \
		EXP_PORT=$(EXP_PORT) node $(EXP_DIR)/exp-host.js

# The one that decides 0.3.0: the same provider, inside Electron's main
# process, alongside a live Chromium. ELECTRON_DISABLE_SANDBOX for the same
# reason as `verify`.
exp-electron: exp-provider-electron
	$(SHELL_RUN) env ELECTRON_DISABLE_SANDBOX=1 EXP_MODE=$(EXP_MODE) \
		EXP_PORT=$(EXP_PORT) npx electron $(EXP_DIR)/exp-electron.js

# EXPERIMENT 2: the in-process CALL path. If this works, 0.3.0 does not need a
# published core_service at all — the gateway exists for OUT-of-process clients.
exp-call: exp-provider
	$(SHELL_RUN) env QT_QPA_PLATFORM=offscreen MODULE=$(MODULE) \
		node $(EXP_DIR)/exp-call-host.js

exp-call-electron: exp-provider-electron
	$(SHELL_RUN) env ELECTRON_DISABLE_SANDBOX=1 MODULE=$(MODULE) \
		npx electron $(EXP_DIR)/exp-call-electron.js

clean:
	rm -rf build dist runtime-bundle $(EXP_DIR)/build
