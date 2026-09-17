#!/usr/bin/env node
// Extra build flags the EXPERIMENT needs beyond the shipped addon's
// scripts/gyp-config.js. Same contract: one shell-free token per line.
'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function fail(msg) {
  process.stderr.write(`exp-config: ${msg}\n`);
  process.exit(1);
}

function logosRoot() {
  const root = process.env.LOGOS_LIBLOGOS_ROOT;
  if (!root) fail('set LOGOS_LIBLOGOS_ROOT');
  return fs.realpathSync(root);
}

// nlohmann/json.hpp is NOT on the dev shell's default include path — it reaches
// consumers as a propagatedBuildInput of the liblogos headers output (see
// logos-liblogos/flake.nix:173, whose comment names the exact
// "fatal error: nlohmann/json.hpp: No such file or directory" this avoids).
// Under `nix develop` that propagation does not happen, so find it in the store.
function nlohmannInclude() {
  if (process.env.NLOHMANN_INCLUDE) return process.env.NLOHMANN_INCLUDE;
  // The protocol lib's symbols are mangled with json_abi_v3_11_3, so the ABI
  // must be 3.11.x. Anything else silently mismatches at link time.
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
  case 'nlohmann_include':
    console.log(nlohmannInclude());
    break;

  case 'extra_libraries': {
    const lib = path.join(logosRoot(), 'lib');
    // logos_qt_host: LogosAPI + LogosAPIProvider.
    // logos_protocol: LogosProviderObject's std<->Qt bridges, TokenManager,
    //                 LogosAPIClient.
    // Qt6Network/Qt6RemoteObjects: pulled in transitively, but naming them
    // keeps the link deterministic under --as-needed.
    const out = ['-llogos_qt_host', '-llogos_protocol'];
    try {
      const qtLibs = execFileSync(
        'pkg-config',
        ['--libs', 'Qt6Network', 'Qt6RemoteObjects'],
        { encoding: 'utf8' }
      ).trim();
      out.push(...qtLibs.split(/\s+/).filter(Boolean));
    } catch {
      // Not fatal: the symbols come in through liblogos_protocol's own NEEDED.
    }
    void lib;
    console.log(out.join('\n'));
    break;
  }

  default:
    fail(`unknown argument ${JSON.stringify(what)}`);
}
