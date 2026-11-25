'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Recorder } = require('../../src/main/recording/recorder');
const { recordingFileName } = require('../../src/main/recording/storage');

function createRecorder(consent) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-rec-'));
  const notices = [];
  const failures = [];
  const segments = [];
  const recorder = new Recorder({
    getFolder: () => folder,
    requestConsent: typeof consent === 'function' ? consent : async () => consent,
    onChange: () => {},
    notify: (text) => notices.push(text),
    onFailure: () => failures.push('failed'),
    onSegment: (filePath, durationMs, final, details) => segments.push({ filePath, final, ...details }),
  });
  return { recorder, folder, notices, failures, segments };
}

// Fails the current part's file the way a full disk would, and waits until the error is seen.
async function failWrite(recorder, error) {
  const { stream } = recorder.file;
  const closed = new Promise((resolve) => stream.once('close', resolve));
  stream.destroy(error);
  await closed;
}

test('recording file names are timestamped .webm files', () => {
  assert.equal(recordingFileName(new Date(2026, 10, 23, 2, 5, 9)), 'recording-20261123-020509.webm');
});

test('nothing is recorded without consent', async () => {
  const { recorder, folder } = createRecorder({ granted: false });
  assert.deepEqual(await recorder.requestStart(), { ok: false, reason: 'declined' });
  assert.equal(recorder.active, false);
  assert.equal(recorder.consumeAuthorization(), false);
  assert.deepEqual(fs.readdirSync(folder), []);
});

test('an unticked permission box tells the user and records nothing', async () => {
  const { recorder, notices } = createRecorder({ granted: false, reason: 'unchecked' });
  await recorder.requestStart();
  assert.equal(recorder.active, false);
  assert.match(notices[0], /permission box/);
});

test('consent authorises exactly one capture and data reaches the file', async () => {
  const { recorder, folder } = createRecorder({ granted: true });
  assert.deepEqual(await recorder.requestStart(), { ok: true });
  assert.equal(recorder.consumeAuthorization(), true);
  assert.equal(recorder.consumeAuthorization(), false);

  assert.equal(recorder.write(new Uint8Array([1, 2, 3])), true);
  const filePath = await recorder.finish();
  assert.equal(path.dirname(filePath), folder);
  assert.deepEqual([...fs.readFileSync(filePath)], [1, 2, 3]);
  assert.equal(recorder.write(new Uint8Array([4])), false);
});

test('aborting a recording that captured nothing removes the empty file', async () => {
  const { recorder, folder } = createRecorder({ granted: true });
  await recorder.requestStart();
  await recorder.abort();
  assert.deepEqual(fs.readdirSync(folder), []);
});

test('only empty recording files are discarded', async () => {
  const { recorder, folder } = createRecorder({ granted: true });
  await recorder.requestStart();
  recorder.write(new Uint8Array([9]));
  const filePath = await recorder.finish();
  assert.equal(recorder.removeIfEmpty(filePath), false);
  assert.equal(fs.readdirSync(folder).length, 1);

  const empty = path.join(folder, 'empty.webm');
  fs.writeFileSync(empty, '');
  assert.equal(recorder.removeIfEmpty(empty), true);
  assert.equal(fs.existsSync(empty), false);
});

test('a second start while the consent dialog is open is refused', async () => {
  let answer;
  const { recorder, folder } = createRecorder(() => new Promise((resolve) => { answer = resolve; }));
  const first = recorder.requestStart();
  assert.deepEqual(await recorder.requestStart(), { ok: false, reason: 'starting' });
  answer({ granted: true });
  assert.deepEqual(await first, { ok: true });
  await recorder.finish();
  assert.equal(fs.readdirSync(folder).length, 1);
});

test('a start can be asked again after the dialog was declined', async () => {
  let granted = false;
  const { recorder } = createRecorder(async () => ({ granted }));
  assert.equal((await recorder.requestStart()).ok, false);
  granted = true;
  assert.equal((await recorder.requestStart()).ok, true);
  await recorder.finish();
});

test('a write error stops the recording once and drops later chunks', async () => {
  const { recorder, notices, failures, segments } = createRecorder({ granted: true });
  await recorder.requestStart();
  recorder.write(new Uint8Array([1, 2, 3]));
  await failWrite(recorder, Object.assign(new Error('disk full'), { code: 'ENOSPC' }));
  assert.deepEqual(failures, ['failed']);
  assert.match(notices.at(-1), /Recording stopped: the file could not be written \(disk full\)/);
  assert.equal(recorder.write(new Uint8Array([4])), false);
  assert.equal(recorder.active, true, 'the interface still has to stop its capture');

  const filePath = await recorder.finish();
  assert.equal(recorder.active, false);
  assert.deepEqual(segments, [{ filePath, final: true, failed: true, markers: [] }]);
  assert.deepEqual(failures, ['failed']);
});

test('switching tabs after a write error ends the recording instead of opening a new part', async () => {
  const { recorder, folder, segments } = createRecorder({ granted: true });
  await recorder.requestStart();
  await failWrite(recorder, new Error('folder removed'));
  assert.deepEqual(await recorder.rollover(), { ok: false, reason: 'write-failed' });
  assert.equal(recorder.active, false);
  assert.equal(segments.length, 1);
  assert.equal(fs.readdirSync(folder).filter((name) => /part2/.test(name)).length, 0);
});

test('a normal recording reports its last part as not failed', async () => {
  const { recorder, segments } = createRecorder({ granted: true });
  await recorder.requestStart();
  recorder.write(new Uint8Array([1]));
  await recorder.finish();
  assert.equal(segments[0].failed, false);
});

test('whenIdle resolves when the recording ends, or reports a timeout', async () => {
  const { recorder } = createRecorder({ granted: true });
  assert.equal(await recorder.whenIdle(10), true);
  await recorder.requestStart();
  assert.equal(await recorder.whenIdle(20), false);
  const waiting = recorder.whenIdle(5000);
  await recorder.finish();
  assert.equal(await waiting, true);
  assert.equal(recorder.idleWaiters.size, 0);
});

test('markers are timed from when the capture really started, without paused time', async () => {
  let now = 10_000;
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-rec-'));
  const recorder = new Recorder({
    getFolder: () => folder, requestConsent: async () => ({ granted: true }), onChange: () => {}, notify: () => {}, now: () => now,
  });
  assert.equal(recorder.addMarker(), null, 'no marker without a recording');
  await recorder.requestStart();
  now += 800; // the capture starts a moment after the consent dialog
  assert.equal(recorder.captureStarted(), true);
  now += 1200;
  assert.deepEqual(recorder.addMarker(), { number: 1, timeMs: 1200, part: 1 });
  recorder.setPaused(true);
  now += 5000;
  recorder.setPaused(false);
  now += 300;
  assert.deepEqual(recorder.addMarker(), { number: 2, timeMs: 1500, part: 1 });
  await recorder.finish();
});
