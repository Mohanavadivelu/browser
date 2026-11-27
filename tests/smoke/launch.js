'use strict';

// Runs each smoke test in its own Electron process, one after another, and stops at the first
// failure. ELECTRON_RUN_AS_NODE is removed first: terminals inside VS Code (itself an Electron
// app) set it, and with it Electron starts as plain Node and every test fails at once.
// Run with: npm run smoke   (or one suite: npm run smoke -- features.js)
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const electron = require('electron'); // the path to the Electron binary when run from Node

const ALL = ['run.js', 'features.js', 'restore.js', 'downloads.js', 'everyday.js'];
const SUITE_TIMEOUT_MS = 15 * 60 * 1000;
const chosen = process.argv.slice(2);
const TESTS = chosen.length ? ALL.filter((name) => chosen.includes(name)) : ALL;
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

// A test file that does not even parse would stop Electron at a blocking error dialog, so
// every file is checked with plain Node first.
for (const name of [...ALL, 'helpers.js']) {
  const syntax = spawnSync(process.execPath, ['--check', path.join(__dirname, name)], { encoding: 'utf8' });
  if (syntax.status !== 0) {
    console.error(`${name} has a syntax error:\n${syntax.stderr}`);
    process.exit(1);
  }
}

for (const name of TESTS) {
  console.log(`\n=== ${name}`);
  // A suite that hangs fails after 15 minutes instead of using up the CI job, and one that ends
  // without reporting its checks (Electron quitting when its last window closes, say) fails too.
  const resultFile = path.join(os.tmpdir(), `sb-smoke-${process.pid}-${name}.json`);
  fs.rmSync(resultFile, { force: true });
  const result = spawnSync(electron, [path.join(__dirname, name)], {
    stdio: 'inherit', env: { ...env, SMOKE_RESULT_FILE: resultFile }, timeout: SUITE_TIMEOUT_MS,
  });
  if (result.error?.code === 'ETIMEDOUT') {
    console.error(`${name} did not finish in ${SUITE_TIMEOUT_MS / 60000} minutes`);
    process.exit(1);
  }
  if (result.error) {
    console.error(`Could not start Electron: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`${name} failed (exit code ${result.status ?? result.signal})`);
    process.exit(result.status || 1);
  }
  if (!fs.existsSync(resultFile)) {
    console.error(`${name} ended without reporting its checks`);
    process.exit(1);
  }
  fs.rmSync(resultFile, { force: true });
}
