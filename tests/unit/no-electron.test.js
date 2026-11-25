'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Unit tests run in parallel under plain Node. A module that loads Electron when it is required
// makes the first test on a fresh machine fetch Electron's binary, and parallel tests then race
// to install it (this broke CI once). So every main-process module the unit tests use must load
// without Electron; code that needs Electron requires it where it is used.
test('the modules the unit tests use load without Electron', () => {
  const unitDir = __dirname;
  const modules = new Set();
  for (const file of fs.readdirSync(unitDir).filter((name) => name.endsWith('.js'))) {
    const text = fs.readFileSync(path.join(unitDir, file), 'utf8');
    for (const match of text.matchAll(/require\('\.\.\/\.\.\/src\/main\/([^']+)'\)/g)) modules.add(match[1]);
  }
  assert.ok(modules.size > 10);
  const script = `
    const Module = require('module');
    const original = Module._resolveFilename;
    Module._resolveFilename = function (request, ...rest) {
      if (request === 'electron') throw new Error('loaded electron');
      return original.call(this, request, ...rest);
    };
    const failed = [];
    for (const name of ${JSON.stringify([...modules])}) {
      try { require(${JSON.stringify(path.join(unitDir, '..', '..', 'src', 'main'))} + '/' + name); }
      catch (error) { failed.push(name + ': ' + error.message); }
    }
    process.stdout.write(JSON.stringify(failed));
  `;
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), []);
});
