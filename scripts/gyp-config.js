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

const what = process.argv[2];

switch (what) {
  case 'include_dirs': {
    // liblogos' own headers. Qt's come in via cflags_cc, since pkg-config
    // reports them as -I flags bundled with the defines Qt requires.
    console.log(path.join(logosRoot(), 'include'));
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
      // rpath, not LD_LIBRARY_PATH: the addon is dlopen'd by the electron
      // binary, and nothing in that launch path can set the environment for it.
      `-Wl,-rpath,${lib}`,
    ];

    // Qt6Core: -L/-l from pkg-config, plus an rpath for its libdir so the
    // addon resolves Qt at runtime the same way it did at link time.
    out.push(...tokens(pkgConfig(['--libs', 'Qt6Core'])));
    const qtLibdir = pkgConfig(['--variable=libdir', 'Qt6Core']);
    if (qtLibdir) out.push(`-Wl,-rpath,${qtLibdir}`);

    console.log(out.join('\n'));
    break;
  }

  default:
    fail(`unknown argument ${JSON.stringify(what)} (expected include_dirs|cflags_cc|libraries)`);
}
