#!/usr/bin/env node
// Collects the Logos runtime into a self-contained, relocatable tree that can be
// shipped inside an AppImage.
//
// THE PROBLEM. Everything Nix builds refers to its dependencies by absolute
// /nix/store path, baked into each ELF file's RUNPATH:
//
//   liblogos_core.so  RUNPATH  /nix/store/...-qtbase-6.9.2/lib:/nix/store/...-boost-1.87.0/lib:...
//
// Those paths do not exist on a user's machine, so copying the files alone
// produces a bundle that cannot resolve a single library. Nor is it one or two
// libraries: liblogos_core pulls in Qt Core/Network/RemoteObjects, Boost,
// OpenSSL, spdlog and fmt, each with its own closure.
//
// THE FIX, in two parts:
//   1. Walk the transitive NEEDED closure from the entry points (ldd), and copy
//      every non-system library into one flat lib/ directory.
//   2. Rewrite each copied file's RUNPATH to $ORIGIN-relative, so the loader
//      resolves siblings wherever the bundle is unpacked.
//
// What is deliberately NOT bundled: glibc, libstdc++, libgcc_s, libm, libdl,
// libpthread and the loader itself. Those come from the host, which is the
// normal AppImage contract — bundling glibc is what breaks on newer hosts.
//
//   node scripts/bundle-runtime.js <output-dir>
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const outDir = process.argv[2] || path.join(__dirname, '..', 'runtime-bundle');
const projectRoot = path.join(__dirname, '..');
const liblogosRoot = fs.realpathSync(
  process.env.LOGOS_LIBLOGOS_ROOT || path.join(projectRoot, 'liblogos')
);
const modulesDir = process.env.MODULES_DIR || path.join(projectRoot, 'modules');

// Libraries that must come from the HOST, not the bundle.
//
// This is glibc and its satellites ONLY. Shipping our own libc alongside the
// host's dynamic loader is the classic way to make an AppImage fail on a
// machine newer than the build host: the loader and the libc must match, and
// the loader is always the host's.
//
// libstdc++ and libgcc_s are deliberately NOT here, though they look like they
// belong. Nix builds against a much newer GCC than a typical distro ships, and
// logos_host is a SEPARATE PROCESS that inherits none of our library paths —
// so on a host with an older libstdc++ it dies at exec with
//
//   logos_host: error while loading shared libraries: libstdc++.so.6:
//     cannot open shared object file
//
// and every module load fails with exit code 127. Both libraries are
// backward-compatible (a newer one runs older code), so bundling them is safe
// in the direction that matters.
const SYSTEM_LIBS = [
  /^ld-linux/,
  /^libc\.so/,
  /^libm\.so/,
  /^libdl\.so/,
  /^librt\.so/,
  /^libpthread\.so/,
  /^libresolv\.so/,
];

const isSystemLib = (name) => SYSTEM_LIBS.some((re) => re.test(name));

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

// Resolve an ELF file's direct dependencies to absolute paths via ldd.
// ldd output lines look like:  libfoo.so.1 => /nix/store/.../libfoo.so.1 (0x...)
function dependenciesOf(file) {
  let out;
  try {
    out = run('ldd', [file]);
  } catch {
    // Not an ELF file, or statically linked: nothing to follow.
    return [];
  }
  const deps = [];
  for (const line of out.split('\n')) {
    const match = line.match(/^\s*(\S+)\s+=>\s+(\/\S+)/);
    if (!match) continue;
    const [, soname, resolved] = match;
    if (isSystemLib(path.basename(soname))) continue;
    deps.push(resolved);
  }
  return deps;
}

// Breadth-first walk of the whole closure, so a dependency-of-a-dependency
// (Qt pulled in by liblogos_core, say) is bundled too.
function collectClosure(entryPoints) {
  const seen = new Map(); // basename -> absolute source path
  const queue = [...entryPoints];

  while (queue.length > 0) {
    const file = queue.shift();
    for (const dep of dependenciesOf(file)) {
      const name = path.basename(dep);
      if (seen.has(name)) continue;
      seen.set(name, fs.realpathSync(dep));
      queue.push(dep);
    }
  }
  return seen;
}

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // Copy through realpath: nix store entries are frequently symlinks, and an
  // AppImage must contain the file, not a link into a store that will not exist.
  fs.copyFileSync(fs.realpathSync(src), dest);
  fs.chmodSync(dest, 0o755);
}

// Point an ELF file at the bundle's own lib/ directory, relative to itself.
function setRunpath(file, runpath) {
  try {
    run('patchelf', ['--set-rpath', runpath, file]);
  } catch (err) {
    console.warn(`  ! patchelf failed on ${path.basename(file)}: ${err.message.split('\n')[0]}`);
  }
}

function copyDirectory(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirectory(from, to);
    } else {
      copyFile(from, to);
    }
  }
}

// --- build the bundle ------------------------------------------------------

console.log(`liblogos: ${liblogosRoot}`);
console.log(`modules:  ${modulesDir}`);
console.log(`output:   ${outDir}\n`);

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(path.join(outDir, 'lib'), { recursive: true });
fs.mkdirSync(path.join(outDir, 'bin'), { recursive: true });

// Entry points: everything that gets loaded or executed at runtime.
//   - the addon, which Electron dlopens
//   - logos_host, which core execs once per module
//   - the module .so files themselves, which carry their own dependencies
//     (delivery drags in Waku and RLN, neither of which anything else needs)
const addon = path.join(projectRoot, 'build', 'Release', 'logos_addon.node');
const logosHost = path.join(liblogosRoot, 'bin', 'logos_host');

const entryPoints = [];
if (fs.existsSync(addon)) entryPoints.push(addon);
if (fs.existsSync(logosHost)) entryPoints.push(logosHost);

// Module plugin .so files, found by walking the installed modules tree.
const modulePlugins = [];
function findPlugins(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    // Versioned names (libpq.so.5.17) count: they are real entry points whose
    // own dependencies must join the closure.
    if (entry.isDirectory()) findPlugins(full);
    else if (/\.so(\.\d+)*$/.test(entry.name)) modulePlugins.push(full);
  }
}
findPlugins(modulesDir);
entryPoints.push(...modulePlugins);

console.log(`entry points (${entryPoints.length}):`);
for (const e of entryPoints) console.log(`  ${path.relative(projectRoot, e)}`);

const closure = collectClosure(entryPoints);
console.log(`\nbundling ${closure.size} shared libraries`);

for (const [name, src] of closure) {
  const dest = path.join(outDir, 'lib', name);
  copyFile(src, dest);
  // A library sits in lib/ alongside its siblings.
  setRunpath(dest, '$ORIGIN');
}

// logos_host lives in bin/, so its siblings are one directory up.
if (fs.existsSync(logosHost)) {
  const dest = path.join(outDir, 'bin', 'logos_host');
  copyFile(logosHost, dest);
  setRunpath(dest, '$ORIGIN/../lib');
  console.log('bundled bin/logos_host');
}

// The modules tree keeps its layout — core resolves plugins by walking it, and
// lgpm's directory structure is what it expects.
if (fs.existsSync(modulesDir)) {
  const destModules = path.join(outDir, 'modules');
  copyDirectory(modulesDir, destModules);

  // Patch EVERY shared object in the tree, not just the plugins found as entry
  // points. A module ships its own versioned libraries alongside the plugin —
  // delivery carries libpq.so.5 and libpq.so.5.17 — and those keep their
  // /nix/store RUNPATH unless they are patched too. Missing them leaves a
  // bundle that works only on the build machine, which is the exact failure
  // this script exists to prevent.
  let patched = 0;
  const patchTree = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        patchTree(full);
      } else if (/\.so(\.\d+)*$/.test(entry.name)) {
        const toLib = path.relative(path.dirname(full), path.join(outDir, 'lib'));
        setRunpath(full, `$ORIGIN:$ORIGIN/${toLib}`);
        patched += 1;
      }
    }
  };
  patchTree(destModules);
  console.log(`bundled modules/ (${patched} shared objects patched)`);
}

// THE ADDON IS PATCHED IN PLACE, not copied into the bundle.
//
// electron-builder packages build/Release/logos_addon.node into
// resources/app.asar.unpacked/build/Release/, while this bundle lands in
// resources/runtime/. From the addon's own directory the libraries are three
// levels up and back down through runtime/lib, so $ORIGIN alone would never
// resolve liblogos_core.
//
// Both entries are kept: the packaged layout first, then $ORIGIN for running
// out of the checkout, where the dev shell supplies the libraries instead.
if (fs.existsSync(addon)) {
  setRunpath(addon, '$ORIGIN/../../../runtime/lib:$ORIGIN');
  console.log('patched build/Release/logos_addon.node for the packaged layout');
}

console.log(`\nbundle ready: ${outDir}`);
