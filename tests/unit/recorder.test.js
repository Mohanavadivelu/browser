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
  const recorder = new Recorder({
    getFolder: () => folder,
    requestConsent: async () => consent,
    onChange: () => {},
    notify: (text) => notices.push(text),
  });
  return { recorder, folder, notices };
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
