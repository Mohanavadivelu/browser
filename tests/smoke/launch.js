'use strict';

// Runs each smoke test in its own Electron process, one after another, and stops at the first
// failure. ELECTRON_RUN_AS_NODE is removed first: terminals inside VS Code (itself an Electron
// app) set it, and with it Electron starts as plain Node and every test fails at once.
// Run with: npm run smoke
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const electron = require('electron'); // the path to the Electron binary when run from Node

const TESTS = ['run.js', 'features.js', 'restore.js'];
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

for (const name of TESTS) {
  console.log(`\n=== ${name}`);
  const result = spawnSync(electron, [path.join(__dirname, name)], { stdio: 'inherit', env });
  if (result.error) {
    console.error(`Could not start Electron: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`${name} failed (exit code ${result.status ?? result.signal})`);
    process.exit(result.status || 1);
  }
}
