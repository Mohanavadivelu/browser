'use strict';

// Starts a packaged build (dist\win-unpacked\Simple Browser.exe by default) with a temporary
// profile and drives it over the DevTools protocol. It catches what the tests from source cannot:
// the app starting from its app.asar, with its fuses, its packed dependencies and the package.json
// electron-builder writes. It also takes a screenshot and makes a short recording, answering the
// native consent dialog through Windows UI Automation (consent.ps1), and checks both are saved
// and shown on the Recordings page. Nothing here uses the network (the page recorded comes from a
// server on this computer).
// Run with: npm run test:packaged   (after building, e.g. npx electron-builder --win dir --x64)
const { spawn, spawnSync, execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

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
  // The portable .exe is a self-extracting wrapper: its fuses are those of the app it unpacks,
  // which electron-builder builds as win-unpacked next to it.
  const app = /portable\.exe$/i.test(exe) ? path.join(path.dirname(exe), 'win-unpacked', 'Simple Browser.exe') : exe;
  const wire = await getCurrentFuseWire(app);
  const state = (name) => String.fromCharCode(wire[FuseV1Options[name]]);
  const wanted = {
    RunAsNode: '0', EnableCookieEncryption: '1', EnableNodeOptionsEnvironmentVariable: '0', EnableNodeCliInspectArguments: '0',
    EnableEmbeddedAsarIntegrityValidation: '1', OnlyLoadAppFromAsar: '1', GrantFileProtocolExtraPrivileges: '0',
  };
  const wrong = Object.entries(wanted).filter(([name, value]) => state(name) !== value).map(([name]) => name);
  check('the fuses are set (file:// extra privileges off, app only from app.asar)', wrong.length === 0, wrong.join(', '));
  const resources = path.join(path.dirname(app), 'resources');
  check('the app is packed in app.asar', fs.existsSync(path.join(resources, 'app.asar')) && !fs.existsSync(path.join(resources, 'app')));
}

async function main() {
  if (!fs.existsSync(exe)) throw new Error(`No packaged app at ${exe}; build it first.`);
  await checkFuses();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-packaged-'));
  const recordings = path.join(profile, 'recordings');
  // blockTrackers off: the check must not download the filter lists.
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ blockTrackers: false, checkForUpdates: false, recordingFolder: recordings }));
  // Windows covered by others (or in the background) are not drawn; the screenshot and the
  // recording need this one drawn, whatever else is open on the desktop.
  const app = spawn(exe, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--disable-features=CalculateNativeWinOcclusion',
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'], { stdio: 'ignore' });
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
    await checkRecording(toolbar, recordings, profile);
  } finally {
    // The portable .exe unpacks and starts the app as a child: stop the whole process tree.
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' });
    else app.kill();
    await sleep(1500);
  }
}

// A page that keeps moving: tab capture only sends a frame when the page changes.
const ANIMATED = '<!doctype html><title>Moving</title><style>@keyframes m{from{left:0}to{left:70vw}}body{margin:0}' +
  '#b{position:absolute;top:80px;width:120px;height:120px;background:#06c;animation:m 1s linear infinite alternate}</style><div id=b></div>';

// An article, for reading mode: its library and script are read from app.asar.
const ARTICLE = `<!doctype html><title>Article</title><article><h1>A morning in the river town</h1>${
  '<p>The river town wakes slowly. Boats knock against the pier while the first ferry warms its engine, and the bakery on the corner sets out the morning bread.</p>'.repeat(12)}</article>`;

async function checkReader(toolbar, url) {
  await evaluate(toolbar, `window.browserApi.nav.go(${JSON.stringify(url)})`);
  const page = await findTarget((t) => t.url === url, 'the article');
  const offered = await waitFor(async () => evaluate(toolbar, "!document.getElementById('reader').hidden"), 'reading mode offered', 10000).catch(() => false);
  const opened = offered && (await evaluate(toolbar, 'window.browserApi.reader.toggle()')) === true &&
    (await evaluate(page, "Boolean(document.querySelector('simple-browser-reader'))")) === true;
  check('reading mode works from the packaged app (Readability read from app.asar)', opened, offered ? '' : 'not offered');
}

// A screenshot, then a few seconds' recording of a moving page: both saved in the recordings
// folder, and listed on the Recordings page with a picture loaded through the sb-media scheme.
async function checkRecording(toolbar, folder, profile) {
  const files = (ext) => (fs.existsSync(folder) ? fs.readdirSync(folder).filter((name) => name.endsWith(ext)) : []);
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(req.url === '/article' ? ARTICLE : ANIMATED);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await recordPage(toolbar, folder, profile, files, `http://127.0.0.1:${server.address().port}/moving`);
    await checkReader(toolbar, `http://127.0.0.1:${server.address().port}/article`);
  } finally {
    server.close();
  }
}

async function recordPage(toolbar, folder, profile, files, url) {
  await evaluate(toolbar, "window.browserApi.tabs.create()");
  await sleep(1000);
  await evaluate(toolbar, `window.browserApi.nav.go(${JSON.stringify(url)})`);
  await findTarget((t) => t.url === url, 'the moving page');
  await sleep(1000);
  const shot = await evaluate(toolbar, 'window.browserApi.screenshot()');
  check('a screenshot is saved as a PNG in the recordings folder', typeof shot === 'string' && files('.png').length === 1 &&
    fs.readFileSync(path.join(folder, files('.png')[0])).subarray(1, 4).toString() === 'PNG', String(shot));

  // Start through the toolbar, as its button does; the consent dialog then waits for an answer.
  const consent = new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'consent.ps1'), '-Profile', profile],
      { windowsHide: true, timeout: 60000 }, (error, stdout) => resolve(!error && /consent given/.test(stdout)));
  });
  await evaluate(toolbar, 'startRecording(), true');
  check('the consent dialog appears, and is answered as a person would', await consent);
  const recording = await waitFor(async () => evaluate(toolbar, 'state?.recording?.active === true'), 'recording started', 20000).catch(() => false);
  check('recording starts once consent is given', recording, recording ? '' : String(await evaluate(toolbar, "document.getElementById('notice').textContent")));
  await sleep(3000);
  await evaluate(toolbar, 'stopRecording(), true');
  const webm = await waitFor(async () => {
    const [name] = files('.webm');
    if (!name || (await evaluate(toolbar, 'state?.recording?.active === true'))) return null;
    const data = fs.readFileSync(path.join(folder, name));
    return data.length > 1000 ? data : null;
  }, 'recording saved', 20000).catch(() => null);
  // Tab capture only sends frames while the window is drawn on screen. On a desktop in use the
  // window can be behind others, and the app then says the recording was empty: that is not the
  // build's fault, so outside CI it is skipped with the reason. CI (nothing else on screen) fails.
  const notice = String(await evaluate(toolbar, "document.getElementById('notice').textContent"));
  if (!webm && /recording was empty/.test(notice) && !process.env.CI) {
    console.log('SKIP  the recording is saved as a WebM file  (the test window was behind other windows, so nothing was drawn to record; CI checks this)');
  } else {
    check('the recording is saved as a WebM file', webm && webm.readUInt32BE(0) === 0x1a45dfa3,
      webm ? `${webm.length} bytes` : `no file; the app said: ${notice}`);
  }

  await evaluate(toolbar, "window.browserApi.nav.go('simple-browser://recordings')");
  const page = await findTarget((t) => t.url.startsWith('app://browser/library.html'), 'recordings page');
  const listed = await waitFor(async () => {
    const count = await evaluate(page, "document.querySelectorAll('#recList .row').length");
    return count >= (webm ? 2 : 1) ? count : null;
  }, 'recordings listed', 10000).catch(() => 0);
  const picture = await waitFor(async () => evaluate(page, `(() => { const img = document.querySelector('#recList .thumb img');
    img?.scrollIntoView(); return img && img.complete && img.naturalWidth > 0; })()`), 'screenshot thumbnail', 10000).catch(() => false);
  check('the Recordings page lists them, and shows the screenshot from the sb-media scheme', listed >= (webm ? 2 : 1) && picture, `${listed} listed`);
}

main()
  .catch((error) => check('packaged app', false, error.message))
  .finally(() => {
    console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
    process.exit(results.length > 0 && results.every(Boolean) ? 0 : 1);
  });
