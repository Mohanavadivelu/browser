'use strict';

// End-to-end smoke test: launches the real app against a local HTTP server and drives it.
// Run with: npm run smoke
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow: ElectronWindow } = require('electron');
const { start } = require('../../src/main/app');

const results = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

function check(name, condition, detail = '') {
  results.push({ name, pass: Boolean(condition), detail });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

const PAGE = '<!doctype html><title>Smoke Page</title><body style="margin:0">' +
  '<h1 style="margin:0;height:240px;background:#e00000;color:#fff">SMOKE TEST PAGE</h1>' +
  '<script>document.cookie="probe=1"</script></body>';

async function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-smoke-'));
  const server = http.createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end(PAGE); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const pageUrl = `http://127.0.0.1:${server.address().port}/`;

  const ctx = await start({
    userDataDir: path.join(work, 'profile'),
    skipSingleInstanceLock: true,
    autoConsent: true,
  });
  const { host, tabs, recorder, settings, ui, win } = ctx;
  settings.update({ recordingFolder: path.join(work, 'recordings') });
  ui.webContents.on('console-message', (event) => console.log(`[chrome ${event.level}] ${event.message}`));
  await waitFor(() => !ui.webContents.isLoading() && win.isVisible(), 'window visible');

  // Sandbox
  const uiPrefs = ui.webContents.getLastWebPreferences();
  const tabPrefs = tabs.active.view.webContents.getLastWebPreferences();
  check('chrome view is sandboxed and isolated', uiPrefs.sandbox && uiPrefs.contextIsolation && !uiPrefs.nodeIntegration);
  check('tab view is sandboxed and isolated', tabPrefs.sandbox && tabPrefs.contextIsolation && !tabPrefs.nodeIntegration);

  // Navigation
  tabs.navigate(pageUrl);
  await waitFor(() => tabs.active.title === 'Smoke Page', 'page title');
  check('navigates to an http page', tabs.snapshot()[0].url === pageUrl);
  const exposed = await tabs.active.view.webContents.executeJavaScript(
    'JSON.stringify([typeof require, typeof process, typeof window.browserApi])');
  check('web page has no Node or app bridge', exposed === '["undefined","undefined","undefined"]', exposed);
  check('javascript: and file: input is blocked',
    !tabs.navigate('javascript:alert(1)').ok && !tabs.navigate('file:///C:/Windows/win.ini').ok);
  const popup = await tabs.active.view.webContents.executeJavaScript(
    'window.open("file:///C:/Windows/win.ini") === null');
  check('page cannot open file: pop-ups', popup === true && tabs.order.length === 1);

  // Tabs and private sessions
  const privateTab = tabs.create({ url: pageUrl, isPrivate: true });
  await waitFor(() => privateTab.title === 'Smoke Page', 'private tab loaded');
  const partition = privateTab.view.webContents.session.storagePath;
  check('private tab uses its own in-memory session', partition === null || partition === undefined,
    String(partition));
  check('two tabs open, private flag set', tabs.order.length === 2 && tabs.snapshot()[1].isPrivate);
  tabs.close(privateTab.id);
  check('closing a tab removes it', tabs.order.length === 1);

  // Full screen
  host.toggleFullscreen();
  await waitFor(() => host.mode.fullscreen, 'full screen on');
  await sleep(300);
  check('full screen hides the browser chrome', ui.getBounds().height === 6, `ui height ${ui.getBounds().height}`);
  check('page fills the window in full screen', tabs.active.view.getBounds().y === 0);
  host.setRevealed(true);
  check('toolbar is revealed from the top edge', ui.getBounds().height === 46);
  host.toggleFullscreen();
  await waitFor(() => !host.mode.fullscreen, 'full screen off');
  await sleep(300);
  check('leaving full screen restores the chrome', ui.getBounds().height === 116);

  // Recording
  ui.webContents.send('recording:command', 'start');
  await waitFor(() => recorder.active, 'recording started');
  await sleep(3500);
  const during = recorder.info;
  ui.webContents.send('recording:command', 'stop');
  await waitFor(() => !recorder.active, 'recording stopped');
  await sleep(500);
  const files = fs.readdirSync(settings.data.recordingFolder);
  const recording = files.map((f) => path.join(settings.data.recordingFolder, f))[0];
  check('recording started after consent', during.active);
  check('recording file saved', files.length === 1 && files[0].endsWith('.webm'), files.join(','));
  check('recording contains data', recording && fs.statSync(recording).size > 5000,
    recording ? `${fs.statSync(recording).size} bytes` : 'no file');

  // Screenshots for manual review
  const shots = path.join(work, 'shots');
  fs.mkdirSync(shots);
  const save = async (name, view) => fs.writeFileSync(path.join(shots, name), (await view.webContents.capturePage()).toPNG());
  await save('chrome.png', ui);
  await save('page.png', tabs.active.view);
  console.log(`Screenshots: ${shots}`);

  // Decode the recording and look for the red test banner to prove tab content was captured.
  if (recording) {
    fs.writeFileSync(path.join(path.dirname(recording), 'probe.html'),
      '<video id="v" muted></video><canvas id="c"></canvas>');
    const probe = new ElectronWindow({ show: false, webPreferences: { sandbox: true } });
    await probe.loadFile(path.join(path.dirname(recording), 'probe.html'));
    const stats = await probe.webContents.executeJavaScript(`new Promise((resolve) => {
      const v = document.getElementById('v');
      v.src = ${JSON.stringify(require('node:url').pathToFileURL(recording).href)};
      v.onerror = () => resolve({ error: 'decode failed' });
      v.play().catch(() => {});
      v.requestVideoFrameCallback(() => {
        const c = document.getElementById('c');
        c.width = v.videoWidth; c.height = v.videoHeight;
        const g = c.getContext('2d'); g.drawImage(v, 0, 0);
        const d = g.getImageData(0, 0, c.width, c.height).data;
        let red = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] > 190 && d[i + 1] < 50 && d[i + 2] < 50) red++;
        resolve({ width: v.videoWidth, height: v.videoHeight, red });
      });
      setTimeout(() => resolve({ error: 'timeout' }), 8000);
    })`);
    probe.destroy();
    check('recording shows the page content', stats.red > 1000, JSON.stringify(stats));
  }

  server.close();
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  app.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error('SMOKE ERROR', error);
  app.exit(2);
});
