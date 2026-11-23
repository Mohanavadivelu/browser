'use strict';

// End-to-end smoke test: launches the real app against a local HTTP server and drives it.
// Run with: npm run smoke
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow: ElectronWindow } = require('electron');
const { start } = require('../../src/main/app');
const {
  trackBytes, ensureWindowReady, sleep, waitFor, createChecker,
} = require('./helpers');

const { check, finish } = createChecker();

const PAGE = '<!doctype html><title>Smoke Page</title><body style="margin:0">' +
  '<h1 style="margin:0;height:240px;background:#e00000;color:#fff">SMOKE TEST PAGE</h1>' +
  '<script>document.cookie="probe=1"</script></body>';

async function main() {
  // The machine running the test may have other windows on top; keep the test window painting.
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-smoke-'));
  const server = http.createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end(PAGE); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const pageUrl = `http://127.0.0.1:${server.address().port}/`;

  const ctx = await start({
    userDataDir: path.join(work, 'profile'),
    skipSingleInstanceLock: true,
    autoConsent: true,
    idleMs: 700,
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

  // Idle auto-hide in full screen (idle time shortened to 700 ms for this test)
  const cursorOf = () => tabs.active.view.webContents.executeJavaScript(
    'getComputedStyle(document.documentElement).cursor');
  host.toggleFullscreen();
  await waitFor(() => host.mode.fullscreen, 'full screen on (idle test)');
  host.setRevealed(true);
  check('toolbar is shown before the idle period', ui.getBounds().height === 46);
  await waitFor(() => ui.getBounds().height === 6, 'toolbar hides after idling', 4000);
  check('toolbar hides itself after idling in full screen', ui.getBounds().height === 6);
  await waitFor(async () => (await cursorOf()) === 'none', 'cursor hidden', 4000);
  check('mouse pointer is hidden after idling', (await cursorOf()) === 'none');
  tabs.active.view.webContents.sendInputEvent({ type: 'mouseMove', x: 60, y: 60 });
  await sleep(250);
  check('moving the mouse brings the pointer back', (await cursorOf()) !== 'none');
  host.toggleFullscreen();
  await waitFor(() => !host.mode.fullscreen, 'full screen off (idle test)');
  await sleep(300);

  // Recording (with a test tone playing in the page)
  const bytes = trackBytes(recorder);
  await sleep(500);
  const audioState = await tabs.active.view.webContents.executeJavaScript(
    `(() => { const c = new AudioContext(); const o = c.createOscillator(); const g = c.createGain();
      g.gain.value = 0.3; o.frequency.value = 440; o.connect(g).connect(c.destination); o.start();
      return c.resume().then(() => c.state); })()`, true);
  check('test tone is playing in the page', audioState === 'running', audioState);
  await ensureWindowReady(ctx);
  ui.webContents.send('recording:command', 'start');
  await waitFor(() => recorder.active, 'recording started');
  await bytes.waitForMore('first recorded data');
  await sleep(2500);
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
  const save = async (name, view) => {
    try {
      fs.writeFileSync(path.join(shots, name), (await view.webContents.capturePage()).toPNG());
    } catch (error) {
      console.log(`Screenshot ${name} skipped: ${error.message}`);
    }
  };
  await save('chrome.png', ui);
  await save('page.png', tabs.active.view);
  console.log(`Screenshots: ${shots}`);

  // Decode the recording and look for the red test banner to prove tab content was captured.
  if (recording) {
    fs.writeFileSync(path.join(path.dirname(recording), 'probe.html'),
      '<video id="v" muted></video><canvas id="c"></canvas>');
    const probe = new ElectronWindow({
      show: false,
      webPreferences: { sandbox: true, autoplayPolicy: 'no-user-gesture-required' },
    });
    await probe.loadFile(path.join(path.dirname(recording), 'probe.html'));
    const stats = await probe.webContents.executeJavaScript(`new Promise((resolve) => {
      const v = document.getElementById('v');
      v.muted = true;
      v.src = ${JSON.stringify(require('node:url').pathToFileURL(recording).href)};
      v.onerror = () => resolve({ error: 'decode failed' });
      v.play().catch(() => {});
      v.requestVideoFrameCallback(() => setTimeout(() => {
        const c = document.getElementById('c');
        c.width = v.videoWidth; c.height = v.videoHeight;
        const g = c.getContext('2d'); g.drawImage(v, 0, 0);
        const d = g.getImageData(0, 0, c.width, c.height).data;
        let red = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] > 190 && d[i + 1] < 50 && d[i + 2] < 50) red++;
        resolve({ width: v.videoWidth, height: v.videoHeight, red, frame: c.toDataURL('image/png') });
      }, 1000));
      setTimeout(() => resolve({ error: 'timeout' }), 10000);
    })`);
    const audioStats = await probe.webContents.executeJavaScript(`(async () => {
      const bytes = await (await fetch(${JSON.stringify(require('node:url').pathToFileURL(recording).href)})).arrayBuffer();
      const decoded = await new AudioContext().decodeAudioData(bytes);
      let peak = 0;
      for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
        for (const s of decoded.getChannelData(ch)) peak = Math.max(peak, Math.abs(s));
      }
      return { seconds: Number(decoded.duration.toFixed(1)), channels: decoded.numberOfChannels, audioPeak: Number(peak.toFixed(3)) };
    })().catch((e) => ({ error: String(e) }))`);
    Object.assign(stats, audioStats);
    probe.destroy();
    if (stats.frame) {
      fs.writeFileSync(path.join(shots, 'recording-frame.png'), Buffer.from(stats.frame.split(',')[1], 'base64'));
      delete stats.frame;
    }
    check('recording shows the page content', stats.red > 1000, JSON.stringify(stats));
    check('recording contains the page audio', stats.audioPeak > 0.05, JSON.stringify(stats));
  }

  server.close();
  app.exit(finish() ? 0 : 1);
}

main().catch((error) => {
  console.error('SMOKE ERROR', error);
  app.exit(2);
});
