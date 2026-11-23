'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { BrowserWindow: ElectronWindow } = require('electron');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

function createChecker() {
  const results = [];
  // Without a listener Electron shows a blocking error dialog and the run carries on; collect the
  // errors instead, so an exception in the main process fails the run.
  const uncaught = [];
  process.on('uncaughtException', (error) => {
    uncaught.push(error);
    console.log(`UNCAUGHT  ${error.stack ?? error}`);
  });
  return {
    results,
    check(name, condition, detail = '') {
      results.push({ name, pass: Boolean(condition), detail });
      console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
    },
    finish() {
      results.push({ name: 'no uncaught errors in the main process', pass: uncaught.length === 0 });
      console.log(`${uncaught.length ? 'FAIL' : 'PASS'}  no uncaught errors in the main process${uncaught.length ? `  (${uncaught.length})` : ''}`);
      const failed = results.filter((result) => !result.pass);
      console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
      return failed.length === 0;
    },
  };
}

const makeTempDir = (prefix = 'sb-smoke-') => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

// Counts the bytes the recorder receives, so tests can wait for real data instead of guessing
// how long capture takes to start.
function trackBytes(recorder) {
  const tracker = { total: 0 };
  const original = recorder.write.bind(recorder);
  recorder.write = (chunk) => {
    tracker.total += chunk.byteLength;
    return original(chunk);
  };
  tracker.waitForMore = async (label, timeout = 20000) => {
    const startTotal = tracker.total;
    await waitFor(() => tracker.total > startTotal, label, timeout);
  };
  return tracker;
}

// Counts the points in a recording's seek index (the Cues element at the end of the file), read
// independently of the app's own WebM code. Returns 0 when there is no index.
function countCuePoints(recordingPath) {
  const buf = fs.readFileSync(recordingPath);
  const at = buf.lastIndexOf(Buffer.from([0x1C, 0x53, 0xBB, 0x6B]));
  if (at < 0) return 0;
  // The size's length is one more than the leading zero bits of its first byte.
  const width = Math.clz32(buf[at + 4]) - 23;
  let size = buf[at + 4] & (0xff >> width);
  for (let i = 1; i < width; i += 1) size = size * 256 + buf[at + 4 + i];
  let pos = at + 4 + width;
  const end = pos + size;
  if (end !== buf.length) return 0; // the index must be the last thing in the file
  let points = 0;
  while (pos < end) {
    if (buf[pos] !== 0xBB) return 0;
    const length = buf[pos + 1] & 0x80 ? buf[pos + 1] & 0x7f : -1;
    if (length < 0) return 0;
    points += 1;
    pos += 2 + length;
  }
  return points;
}

// Decodes a recording in a hidden window and reports its size, how much of the red test banner
// is visible one second in, and the loudest audio sample.
async function inspectRecording(recordingPath) {
  const probe = new ElectronWindow({
    show: false,
    webPreferences: { sandbox: true, autoplayPolicy: 'no-user-gesture-required' },
  });
  try {
    const probePage = path.join(path.dirname(recordingPath), 'probe.html');
    fs.writeFileSync(probePage, '<video id="v" muted></video><canvas id="c"></canvas>');
    await probe.loadFile(probePage);
    const url = JSON.stringify(pathToFileURL(recordingPath).href);
    const video = await probe.webContents.executeJavaScript(`new Promise((resolve) => {
      const v = document.getElementById('v');
      v.muted = true;
      v.src = ${url};
      v.onerror = () => resolve({ error: 'decode failed' });
      v.play().catch(() => {});
      v.requestVideoFrameCallback(() => setTimeout(() => {
        const c = document.getElementById('c');
        c.width = v.videoWidth; c.height = v.videoHeight;
        const g = c.getContext('2d'); g.drawImage(v, 0, 0);
        const d = g.getImageData(0, 0, c.width, c.height).data;
        let red = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] > 190 && d[i + 1] < 50 && d[i + 2] < 50) red++;
        resolve({ width: v.videoWidth, height: v.videoHeight, red });
      }, 1000));
      setTimeout(() => resolve({ error: 'timeout' }), 10000);
    })`);
    const audio = await probe.webContents.executeJavaScript(`(async () => {
      const bytes = await (await fetch(${url})).arrayBuffer();
      const decoded = await new AudioContext().decodeAudioData(bytes);
      let peak = 0;
      for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
        for (const s of decoded.getChannelData(ch)) peak = Math.max(peak, Math.abs(s));
      }
      return { seconds: Number(decoded.duration.toFixed(1)), audioPeak: Number(peak.toFixed(3)) };
    })().catch((e) => ({ audioError: String(e) }))`);
    // What a player sees: a length, and how a jump to 70% of the way through goes.
    const seek = await probe.webContents.executeJavaScript(`new Promise((resolve) => {
      const v = document.getElementById('v');
      const duration = v.duration;
      if (!Number.isFinite(duration)) { resolve({ duration: null }); return; }
      const target = duration * 0.7;
      const t0 = performance.now();
      v.pause();
      v.onseeked = () => resolve({ duration, seekTarget: target, seekedTo: v.currentTime, seekMs: Math.round(performance.now() - t0) });
      v.currentTime = target;
      setTimeout(() => resolve({ duration, seekError: 'no seeked event in 5 s' }), 5000);
    })`);
    const round = (value) => (typeof value === 'number' ? Number(value.toFixed(2)) : value);
    return {
      ...video,
      ...audio,
      ...Object.fromEntries(Object.entries(seek).map(([key, value]) => [key, round(value)])),
      cuePoints: countCuePoints(recordingPath),
    };
  } finally {
    probe.destroy();
  }
}

// Brings the test window back if something on the machine minimized it, and waits for the page
// view to have a real size, because a zero-size page cannot be recorded.
async function ensureWindowReady(ctx) {
  if (ctx.win.isMinimized()) ctx.win.restore();
  if (!ctx.win.isVisible()) ctx.win.show();
  ctx.host.layout();
  await waitFor(() => {
    const bounds = ctx.tabs.active?.view.getBounds();
    return bounds && bounds.width > 0 && bounds.height > 0;
  }, 'the page view has a size');
}

module.exports = {
  sleep, waitFor, createChecker, makeTempDir, trackBytes, ensureWindowReady, inspectRecording,
};
