'use strict';

// Starts a packaged build (dist\win-unpacked\Simple Browser.exe by default) with a temporary
// profile and drives it over the DevTools protocol. It catches what the tests from source cannot:
// the app starting from its app.asar, with its fuses, its packed dependencies and the package.json
// electron-builder writes. Nothing here uses the network.
// Run with: npm run test:packaged   (after building, e.g. npx electron-builder --win dir --x64)
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const exe = process.argv[2] ?? path.join(__dirname, '..', '..', 'dist', 'win-unpacked', 'Simple Browser.exe');
const PORT = 9360;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok));
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

async function waitFor(fn, label, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {
      // not there yet
    }
    await sleep(300);
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

const targets = async () => (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const findTarget = (match, label, timeout) => waitFor(async () => (await targets()).find(match), label, timeout);

async function evaluate(target, expression) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('DevTools connection failed'));
  });
  const reply = new Promise((resolve) => {
    ws.onmessage = (message) => {
      const data = JSON.parse(message.data);
      if (data.id === 1) resolve(data);
    };
  });
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  const answer = await reply;
  ws.close();
  return answer.result?.result?.value ?? answer.result?.exceptionDetails?.exception?.description;
}

// The fuses package.json asks for, as the built .exe has them (0 = off, 1 = on).
async function checkFuses() {
  const { getCurrentFuseWire, FuseV1Options } = require('@electron/fuses');
  const wire = await getCurrentFuseWire(exe);
  const state = (name) => String.fromCharCode(wire[FuseV1Options[name]]);
  const wanted = {
    RunAsNode: '0', EnableCookieEncryption: '1', EnableNodeOptionsEnvironmentVariable: '0', EnableNodeCliInspectArguments: '0',
    EnableEmbeddedAsarIntegrityValidation: '1', OnlyLoadAppFromAsar: '1', GrantFileProtocolExtraPrivileges: '0',
  };
  const wrong = Object.entries(wanted).filter(([name, value]) => state(name) !== value).map(([name]) => name);
  check('the fuses are set (file:// extra privileges off, app only from app.asar)', wrong.length === 0, wrong.join(', '));
  const resources = path.join(path.dirname(exe), 'resources');
  check('the app is packed in app.asar', fs.existsSync(path.join(resources, 'app.asar')) && !fs.existsSync(path.join(resources, 'app')));
}

async function main() {
  if (!fs.existsSync(exe)) throw new Error(`No packaged app at ${exe}; build it first.`);
  await checkFuses();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-packaged-'));
  // blockTrackers off: the check must not download the filter lists.
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ blockTrackers: false, checkForUpdates: false }));
  const app = spawn(exe, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`], { stdio: 'ignore' });
  try {
    const toolbar = await findTarget((t) => t.url === 'app://browser/index.html', 'the toolbar (the app did not start)', 60000);
    check('the browser pages are served as app://browser/', Boolean(toolbar));
    const tabs = await waitFor(async () => evaluate(toolbar, "document.querySelectorAll('#tabs .tab').length"), 'tab strip').catch(() => 0);
    check('the toolbar draws its tab strip', tabs >= 1, `${tabs} tab(s)`);

    const newTab = await findTarget((t) => t.url.startsWith('app://browser/newtab.html'), 'new tab page');
    check('web tabs have no bridge to the app', (await evaluate(newTab, 'typeof window.browserApi')) === 'undefined');

    await evaluate(toolbar, `(() => { const a = document.getElementById('address'); a.focus();
      a.dispatchEvent(new FocusEvent('focus')); a.value = 'packaged check';
      a.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    const suggestion = await waitFor(async () => evaluate(toolbar, "document.querySelector('#suggestions .suggestion')?.textContent ?? ''"), 'suggestions', 5000).catch(() => '');
    check('the address bar suggests a search', /Search Google/.test(suggestion), suggestion);

    await evaluate(toolbar, "window.browserApi.nav.go('simple-browser://bookmarks')");
    const library = await findTarget((t) => t.url.startsWith('app://browser/library.html'), 'bookmarks page');
    const bookmarksText = () => evaluate(library, "document.getElementById('bookmarkList')?.textContent ?? ''");
    await waitFor(async () => /No bookmarks yet/.test(await bookmarksText()), 'bookmarks list', 8000).catch(() => {});
    const bookmarks = await bookmarksText();
    check('the bookmarks page loads', /No bookmarks yet/.test(bookmarks), String(bookmarks).slice(0, 80));
    const refused = String(await evaluate(library, "window.browserApi.recording.requestStart().then(() => 'allowed', (e) => e.message)"));
    check('a browser page cannot call what it is not allowed', /from the library page/.test(refused));
  } finally {
    // The portable .exe unpacks and starts the app as a child: stop the whole process tree.
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' });
    else app.kill();
    await sleep(1500);
  }
}

main()
  .catch((error) => check('packaged app', false, error.message))
  .finally(() => {
    console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
    process.exit(results.length > 0 && results.every(Boolean) ? 0 : 1);
  });
