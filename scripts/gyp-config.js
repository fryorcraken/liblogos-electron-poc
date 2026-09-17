#!/usr/bin/env node
// Resolves build flags for binding.gyp, which cannot call pkg-config or read
// the environment itself. gyp shells out to this via <!@(node scripts/gyp-config.js <what>)
// and splits the stdout on whitespace — so every value printed here must be a
// single shell-free token, one per line.
//
// Two sources, because liblogos and Qt are found in different ways:
//   liblogos  LOGOS_LIBLOGOS_ROOT, a `nix build` result dir (include/ lib/ bin/)
//   Qt6Core   pkg-config, matching how liblogos itself was built
'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function fail(msg) {
  process.stderr.write(`gyp-config: ${msg}\n`);
  process.exit(1);
}

function pkgConfig(args) {
  try {
    return execFileSync('pkg-config', args, { encoding: 'utf8' }).trim();
  } catch (err) {
    fail(
      `pkg-config ${args.join(' ')} failed. Enter liblogos' dev shell first:\n` +
        `  nix develop 'github:logos-co/logos-liblogos' -c npm run build\n${err.message}`
    );
  }
}

function tokens(str) {
  return str.split(/\s+/).filter(Boolean);
}

// The liblogos nix result. Kept as a variable rather than baked in so the same
// tree builds against a local checkout's ./result or a store path.
function logosRoot() {
  const root = process.env.LOGOS_LIBLOGOS_ROOT;
  if (!root) {
    fail(
      'set LOGOS_LIBLOGOS_ROOT to the logos-liblogos `nix build` result dir\n' +
        "  nix build 'github:logos-co/logos-liblogos' -o ./liblogos\n" +
        '  LOGOS_LIBLOGOS_ROOT="$PWD/liblogos" npm run build'
    );
  }
  // Resolve through the nix result symlink: rpath entries must name the real
  // store path, or the addon breaks the moment the symlink is re-pointed.
  const real = fs.realpathSync(root);
  if (!fs.existsSync(path.join(real, 'include', 'logos_core.h'))) {
    fail(`no include/logos_core.h under LOGOS_LIBLOGOS_ROOT (${real})`);
  }
  return real;
}

// nlohmann/json.hpp is NOT on the dev shell's default include path. It reaches
// consumers as a propagatedBuildInput of the liblogos headers output (see
// logos-liblogos/flake.nix:173, whose comment names the exact "fatal error:
// nlohmann/json.hpp: No such file or directory" this avoids), and under
// `nix develop` that propagation does not happen — so find it in the store.
//
// THE VERSION IS NOT FREE. liblogos_protocol.so's symbols are mangled with
// json_abi_v3_11_3, so anything outside 3.11.x links against a differently-named
// inline namespace and the call silently fails to resolve. Pinning the major.minor
// here is what keeps that a build error rather than a runtime one.
function nlohmannInclude() {
  if (process.env.NLOHMANN_INCLUDE) return process.env.NLOHMANN_INCLUDE;
  const candidates = fs
    .readdirSync('/nix/store')
    .filter((d) => /-nlohmann_json-3\.11\./.test(d))
    .map((d) => path.join('/nix/store', d, 'include'))
    .filter((p) => fs.existsSync(path.join(p, 'nlohmann', 'json.hpp')));
  if (!candidates.length) {
    fail('no nlohmann_json-3.11.x in /nix/store; set NLOHMANN_INCLUDE');
  }
  return candidates[0];
}

const what = process.argv[2];

switch (what) {
  case 'include_dirs': {
    // liblogos' own headers. Qt's come in via cflags_cc, since pkg-config
    // reports them as -I flags bundled with the defines Qt requires.
    console.log(path.join(logosRoot(), 'include'));
    // nlohmann/json.hpp, for 0.3.0's call path: logos::nlohmannArgsToQVariantList
    // and qvariantToNlohmann take it by reference, so the header is needed to
    // compile a call to them. See nlohmannInclude() for the ABI trap.
    console.log(nlohmannInclude());
    break;
  }

  case 'cflags_cc': {
    // Qt6Core's --cflags carries more than include paths: -fPIC and the
    // QT_CORE_LIB / QT_NO_DEBUG defines Qt headers check for. Passing the
    // lot verbatim is what keeps this consistent with how liblogos was built.
    console.log(tokens(pkgConfig(['--cflags', 'Qt6Core'])).join('\n'));
    break;
  }

  case 'libraries': {
    const root = logosRoot();
    const lib = path.join(root, 'lib');
    const out = [
      `-L${lib}`,
      '-llogos_core',
      // 0.3.0: the in-process call and event path.
      //   logos_qt_host   LogosAPI (construction, getClient)
      //   logos_protocol  LogosAPIClient::invokeRemoteMethod /
      //                   onEventWhenAvailable, and the json<->QVariant bridges
      //
      // This is the ABI commitment docs/0.3.0-inventory.md §5.9 flags: 0.1.0
      // bound only the C ABI, which was deliberate insulation, and linking the
      // C++ host runtime gives that up. Both .so files are already in
      // bundle-runtime.js's output tree, so the AppImage does not grow.
      '-llogos_qt_host',
      '-llogos_protocol',
      // rpath, not LD_LIBRARY_PATH: the addon is dlopen'd by the electron
      // binary, and nothing in that launch path can set the environment for it.
      `-Wl,-rpath,${lib}`,
    ];

    // Qt6Core: -L/-l from pkg-config, plus an rpath for its libdir so the
    // addon resolves Qt at runtime the same way it did at link time.
    out.push(...tokens(pkgConfig(['--libs', 'Qt6Core'])));
    // Named explicitly rather than left to liblogos_protocol's own NEEDED:
    // --as-needed drops a DT_NEEDED the link did not visibly use, and the QtRO
    // round trip is reached through virtual dispatch, where the linker cannot
    // see the use. Both are in the same dev shell as Qt6Core, so a missing one
    // means the shell is wrong and stopping is the right answer.
    out.push(...tokens(pkgConfig(['--libs', 'Qt6Network', 'Qt6RemoteObjects'])));
    const qtLibdir = pkgConfig(['--variable=libdir', 'Qt6Core']);
    if (qtLibdir) out.push(`-Wl,-rpath,${qtLibdir}`);

    console.log(out.join('\n'));
    break;
  }

  default:
    fail(`unknown argument ${JSON.stringify(what)} (expected include_dirs|cflags_cc|libraries)`);
}
