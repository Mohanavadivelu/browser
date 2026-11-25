'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeRecording, keyframeTimes } = require('../../src/main/recording/webm-edit');
const { WebmIndexer } = require('../../src/main/recording/webm');
const { trimRecording, joinRecording, partsOf, freeName, RecordingIndex } = require('../../src/main/recording/library');
const { header, cluster, simpleBlock, inspect, readHeader } = require('./webm-fixtures');

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sb-edit-'));

// Video keyframes at 0, 2005 and 3000; block markers number the blocks in order.
function recording(options) {
  return Buffer.concat([
    header(options),
    cluster(0, simpleBlock(1, 0, true, 1), simpleBlock(2, 0, true, 2), simpleBlock(1, 33, false, 3)),
    cluster(1000, simpleBlock(2, 0, true, 4), simpleBlock(1, 10, false, 5), simpleBlock(1, 40, false, 6)),
    cluster(2000, simpleBlock(2, 0, true, 7), simpleBlock(1, 5, true, 8), simpleBlock(1, 38, false, 9)),
    cluster(3000, simpleBlock(1, 0, true, 10), simpleBlock(2, 20, true, 11), simpleBlock(1, 60, false, 12)),
  ]);
}

// Saves `bytes` the way the recorder does: through the indexer, so the file has its index.
function saveIndexed(folder, name, bytes) {
  const indexer = new WebmIndexer();
  const filePath = path.join(folder, name);
  const written = indexer.push(bytes);
  const plan = indexer.finalize();
  const file = Buffer.concat([written, plan.append]);
  for (const patch of plan.patches) patch.bytes.copy(file, patch.position);
  fs.writeFileSync(filePath, file);
  return filePath;
}

test('keyframes are found in a recording', async () => {
  const folder = temp();
  assert.deepEqual(await keyframeTimes(saveIndexed(folder, 'a.webm', recording())), [0, 2005, 3000]);
});

test('a trim starts on the keyframe at or before the start, and times start at zero', async () => {
  const folder = temp();
  const source = saveIndexed(folder, 'a.webm', recording());
  const out = path.join(folder, 'cut.webm');
  const result = await writeRecording(out, [{ path: source, from: 2100, to: 3020 }]);
  assert.deepEqual(result, { durationMs: 1015, startMs: 2005, markers: [] });
  const file = inspect(fs.readFileSync(out));
  assert.deepEqual(file.blocks.map((b) => [b.marker, b.time, b.key]), [[8, 0, true], [9, 33, false], [10, 995, true], [11, 1015, true]]);
  assert.equal(file.duration, 1015);
  assert.deepEqual(file.cues.map((cue) => cue.time), [0, 995]);
  assert.equal(file.segmentSize, fs.statSync(out).size - file.segmentData);
  for (const cue of file.cues) assert.equal(readHeader(fs.readFileSync(out), file.segmentData + cue.position).id, 0x1F43B675);
});

test('a trim of the whole recording keeps every block', async () => {
  const folder = temp();
  const source = saveIndexed(folder, 'a.webm', recording());
  const out = path.join(folder, 'all.webm');
  await writeRecording(out, [{ path: source }]);
  assert.deepEqual(inspect(fs.readFileSync(out)).blocks.map((b) => b.marker), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
});

test('joined parts follow one another in time', async () => {
  const folder = temp();
  const one = saveIndexed(folder, 'x.webm', recording());
  const two = saveIndexed(folder, 'x-part2.webm', recording());
  const out = path.join(folder, 'joined.webm');
  const result = await writeRecording(out, [{ path: one }, { path: two }]);
  const file = inspect(fs.readFileSync(out));
  assert.equal(file.blocks.length, 24);
  const times = file.blocks.map((b) => b.time);
  assert.equal(times[12], 3060 + 33, 'the second part starts one frame after the first ends');
  assert.equal(result.durationMs, 3060 + 33 + 3060);
  assert.deepEqual(file.cues.map((cue) => cue.time), [0, 2005, 3000, 3093, 5098, 6093]);
});

test('parts recorded in different formats are not joined, and nothing is left behind', async () => {
  const folder = temp();
  const vp9 = saveIndexed(folder, 'x.webm', recording());
  const vp8 = saveIndexed(folder, 'x-part2.webm', recording({ videoCodec: 'V_VP8' }));
  const out = path.join(folder, 'joined.webm');
  await assert.rejects(writeRecording(out, [{ path: vp9 }, { path: vp8 }]), /different formats/);
  assert.equal(fs.existsSync(out), false);
});

test('a cut-off recording is trimmed up to where it ends', async () => {
  const folder = temp();
  const bytes = recording();
  const cutOff = path.join(folder, 'cut-off.webm');
  fs.writeFileSync(cutOff, bytes.subarray(0, bytes.length - 10));
  const out = path.join(folder, 'out.webm');
  await writeRecording(out, [{ path: cutOff }]);
  assert.deepEqual(inspect(fs.readFileSync(out)).blocks.map((b) => b.marker), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
});

test('files that are not recordings are refused', async () => {
  const folder = temp();
  const notWebm = path.join(folder, 'x.webm');
  fs.writeFileSync(notWebm, 'not a recording');
  await assert.rejects(writeRecording(path.join(folder, 'o.webm'), [{ path: notWebm }]), /not a WebM recording/);
});

test('trimmed and joined copies get free names next to the originals and their length is kept', async () => {
  const folder = temp();
  saveIndexed(folder, 'recording-1.webm', recording());
  saveIndexed(folder, 'recording-1-part2.webm', recording());
  saveIndexed(folder, 'recording-1-part10.webm', recording());
  fs.writeFileSync(path.join(folder, 'recording-1-trimmed.webm'), 'taken');
  assert.deepEqual(partsOf(folder, 'recording-1-part2.webm'), ['recording-1.webm', 'recording-1-part2.webm', 'recording-1-part10.webm']);
  assert.equal(freeName(folder, 'recording-1', 'trimmed'), 'recording-1-trimmed-2.webm');

  const index = new RecordingIndex(path.join(folder, 'index.json'));
  const trimmed = await trimRecording(folder, 'recording-1.webm', 2100, 3020, index, writeRecording);
  assert.deepEqual(trimmed, { ok: true, name: 'recording-1-trimmed-2.webm', startMs: 2005, durationMs: 1015 });
  assert.equal(index.get('recording-1-trimmed-2.webm'), 1015);

  const joined = await joinRecording(folder, 'recording-1.webm', index, writeRecording);
  assert.equal(joined.ok, true);
  assert.equal(joined.name, 'recording-1-joined.webm');
  assert.equal(joined.parts, 3);
  assert.equal(index.get('recording-1-joined.webm'), joined.durationMs);

  assert.equal((await trimRecording(folder, '../recording-1.webm', 0, 10, index, writeRecording)).reason, 'invalid-name');
  assert.equal((await trimRecording(folder, 'recording-1.webm', 500, 100, index, writeRecording)).reason, 'invalid-range');
  assert.equal((await joinRecording(folder, 'recording-1-trimmed.webm', index, writeRecording)).reason, 'no-parts');
});

test('markers are written as chapters that players list, and dropped past the end', () => {
  const indexer = new WebmIndexer();
  const written = indexer.push(recording());
  const plan = indexer.finalize({ chapters: [2010.4, 500, 99999] });
  const bytes = Buffer.concat([written, plan.append]);
  for (const patch of plan.patches) patch.bytes.copy(bytes, patch.position);
  const file = inspect(bytes);
  assert.deepEqual(plan.markers, [500, 2010]);
  assert.deepEqual(file.chapters, [{ ms: 500, name: 'Marker 1' }, { ms: 2010, name: 'Marker 2' }]);
  assert.equal(readHeader(bytes, file.segmentData + file.seek['1043a770']).id, 0x1043A770);
  // Chromium cannot decode a file whose chapters come after its clusters.
  assert.ok(file.seek['1043a770'] < file.clusters[0], 'chapters come before the first cluster');
  assert.equal(readHeader(bytes, file.segmentData + file.seek['1c53bb6b']).id, 0x1C53BB6B);
  assert.equal(file.segmentSize, bytes.length - file.segmentData);
});

test('trimmed and joined copies keep the markers inside them, moved with their part', async () => {
  const folder = temp();
  const one = saveIndexed(folder, 'x.webm', recording());
  const two = saveIndexed(folder, 'x-part2.webm', recording());
  const trimmed = await writeRecording(path.join(folder, 't.webm'), [{ path: one, from: 2100, to: 3020, markers: [100, 2100, 3010, 3050] }]);
  assert.deepEqual(trimmed.markers, [95, 1005]);
  assert.deepEqual(inspect(fs.readFileSync(path.join(folder, 't.webm'))).chapters.map((c) => c.ms), [95, 1005]);
  const joined = await writeRecording(path.join(folder, 'j.webm'), [{ path: one, markers: [100] }, { path: two, markers: [200] }]);
  assert.deepEqual(joined.markers, [100, 3093 + 200]);
});

test('the recordings index keeps markers with the file, and still reads the older index', () => {
  const folder = temp();
  const file = path.join(folder, 'index.json');
  fs.writeFileSync(file, JSON.stringify({ 'old.webm': 4200 }));
  const index = new RecordingIndex(file);
  index.load();
  assert.equal(index.get('old.webm'), 4200);
  assert.deepEqual(index.markersOf('old.webm'), []);
  index.setMarkers('new.webm', [3000.6, 1000, -5, 'x']);
  index.set('new.webm', 5000);
  const again = new RecordingIndex(file);
  again.load();
  assert.deepEqual(again.markersOf('new.webm'), [1000, 3001]);
  again.rename('new.webm', 'renamed.webm');
  assert.deepEqual([again.markersOf('renamed.webm'), again.get('renamed.webm'), again.markersOf('new.webm')], [[1000, 3001], 5000, []]);
  again.remove('renamed.webm');
  assert.deepEqual([again.markersOf('renamed.webm'), again.get('renamed.webm')], [[], null]);
});
