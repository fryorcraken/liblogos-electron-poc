#!/usr/bin/env node
// Drives the addon under plain Node, with no Electron in the picture.
//
// This exists to split one question into two. When the Electron app fails, the
// useful thing to know first is whether the binding itself works at all — if
// this passes and Electron does not, the difference is Chromium (symbol
// collisions, competing event loops), not the binding. That is the Qt/Electron
// coexistence risk this PoC set out to test.
//
//   LOGOS_HOST_PATH=... QT_QPA_PLATFORM=offscreen npm run smoke -- ./modules test_basic_module
'use strict';

const path = require('node:path');
const liblogos = require('../src/index.js');

const [modulesDir = './modules', moduleName = 'test_basic_module'] = process.argv.slice(2);
const absModulesDir = path.resolve(modulesDir);

function step(label, fn) {
  process.stdout.write(`${label}... `);
  const started = Date.now();
  const result = fn();
  console.log(`ok (${Date.now() - started}ms)`);
  return result;
}

step('init', () => liblogos.init());
step(`addModulesDir(${absModulesDir})`, () => liblogos.addModulesDir(absModulesDir));
step('start', () => liblogos.start());

console.log('\nknown modules:');
for (const name of liblogos.knownModules()) console.log(`  - ${name}`);

// Blocks for the whole bring-up; see the threading note in addon.cc.
const loaded = step(`loadModule(${moduleName})`, () => liblogos.loadModule(moduleName));
console.log(`load result: ${loaded}`);

console.log('\nloaded modules:');
for (const name of liblogos.loadedModules()) console.log(`  - ${name}`);

const info = liblogos.modulesInfo();
console.log(`\nmodulesInfo(): ${info.length} entries`);
for (const entry of info) {
  console.log(`  - ${entry.name} loaded=${entry.loaded} deps=[${(entry.dependencies ?? []).join(', ')}]`);
}

liblogos.cleanup();
console.log('\ncleanup ok');

if (!loaded) {
  console.error(`\nFAILED: ${moduleName} did not load`);
  process.exit(1);
}
console.log(`\nPASS: ${moduleName} loaded through liblogos from Node`);
