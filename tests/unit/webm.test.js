'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WebmIndexer, applyIndex } = require('../../src/main/recording/webm');

// ---------- A tiny WebM writer, shaped like Chromium's MediaRecorder output ----------

const idBytes = (id) => Buffer.from(id.toString(16).padStart(id > 0xffffff ? 8 : id > 0xffff ? 6 : id > 0xff ? 4 : 2, '0'), 'hex');
function size(n) {
  if (n < 127) return Buffer.from([0x80 | n]);
  if (n < 16383) return Buffer.from([0x40 | (n >> 8), n & 0xff]);
  const out = Buffer.alloc(4);
  out.writeUInt32BE(n);
  out[0] |= 0x10;
  return out;
}
const el = (id, ...parts) => {
  const data = Buffer.concat(parts.map((part) => (typeof part === 'string' ? Buffer.from(part) : part)));
  return Buffer.concat([idBytes(id), size(data.length), data]);
};
const uint = (id, value) => el(id, Buffer.from([value >> 24 & 0xff, value >> 16 & 0xff, value >> 8 & 0xff, value & 0xff]));
const UNKNOWN = Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);

function simpleBlock(track, relative, key, payload = 20) {
  const head = Buffer.alloc(4);
  head[0] = 0x80 | track;
  head.writeInt16BE(relative, 1);
  head[3] = key ? 0x80 : 0;
  return el(0xA3, head, Buffer.alloc(payload, 7));
}

function blockGroup(track, relative) {
  const head = Buffer.alloc(4);
  head[0] = 0x80 | track;
  head.writeInt16BE(relative, 1);
  return el(0xA0, el(0xA1, head, Buffer.alloc(10, 3)), uint(0xFB, 0));
}

function header() {
  return Buffer.concat([
    el(0x1A45DFA3, uint(0x4286, 1), el(0x4282, 'webm')),
    Buffer.from([0x18, 0x53, 0x80, 0x67]), UNKNOWN,
    el(0x1549A966, uint(0x2AD7B1, 1000000), el(0x4D80, 'Chrome'), el(0x5741, 'Chrome')),
    el(0x1654AE6B,
      el(0xAE, uint(0xD7, 1), uint(0x83, 1), el(0x86, 'V_VP9')),
      el(0xAE, uint(0xD7, 2), uint(0x83, 2), el(0x86, 'A_OPUS'))),
  ]);
}

const unknownCluster = (time, ...blocks) => Buffer.concat([Buffer.from([0x1F, 0x43, 0xB6, 0x75]), UNKNOWN, uint(0xE7, time), ...blocks]);
const sizedCluster = (time, ...blocks) => el(0x1F43B675, uint(0xE7, time), ...blocks);

// Cluster at 0 s starts with a keyframe; at 1 s the first video frame is not a keyframe; at 2 s
// the keyframe comes after an audio block; the last cluster has a known size and a BlockGroup.
function recording() {
  const clusters = [
    unknownCluster(0, simpleBlock(1, 0, true, 300), simpleBlock(2, 0, true), simpleBlock(1, 33, false)),
    unknownCluster(1000, simpleBlock(2, 0, true), simpleBlock(1, 10, false), simpleBlock(1, 40, false)),
    unknownCluster(2000, simpleBlock(2, 0, true), simpleBlock(1, 5, true, 500), simpleBlock(1, 38, false)),
    sizedCluster(3000, simpleBlock(1, 0, true), simpleBlock(2, 20, true), blockGroup(2, 30)),
  ];
  return { head: header(), clusters, bytes: Buffer.concat([header(), ...clusters]) };
}

// Feeds `input` to an indexer in pieces of the given sizes (cycled) and applies the result.
function index(input, pieces = [input.length]) {
  const indexer = new WebmIndexer();
  const out = [];
  let pos = 0;
  for (let i = 0; pos < input.length; i += 1) {
    const n = Math.max(1, pieces[i % pieces.length]);
    out.push(indexer.push(input.subarray(pos, pos + n)));
    pos += n;
  }
  out.push(indexer.flush());
  const written = Buffer.concat(out);
  const plan = indexer.finalize();
  if (!plan) return { written, plan, file: written };
  assert.equal(plan.appendAt, written.length);
  const file = Buffer.concat([written, plan.append]);
  for (const patch of plan.patches) patch.bytes.copy(file, patch.position);
  return { written, plan, file };
}

// ---------- An independent reader for checking the result ----------

function readVint(buf, pos, keep) {
  const first = buf[pos];
  assert.ok(pos < buf.length && first !== 0, `valid vint at ${pos}`);
  let length = 1;
  while (!(first & (0x80 >> (length - 1)))) length += 1;
  let value = keep ? first : first & (0xff >> length);
  for (let i = 1; i < length; i += 1) value = value * 256 + buf[pos + i];
  const unknown = !keep && buf.subarray(pos, pos + length).equals(UNKNOWN.subarray(8 - length));
  return { value, length, unknown };
}

function readHeader(buf, pos) {
  const id = readVint(buf, pos, true);
  const sz = readVint(buf, pos + id.length, false);
  return { id: id.value, size: sz.value, unknown: sz.unknown, data: pos + id.length + sz.length };
}

function readChildren(buf, start, end) {
  const list = [];
  for (let pos = start; pos < end;) {
    const h = readHeader(buf, pos);
    list.push({ ...h, at: pos });
    pos = h.data + h.size;
  }
  return list;
}

const uintAt = (buf, h) => buf.readUIntBE(h.data + Math.max(0, h.size - 6), Math.min(h.size, 6));

function inspect(file) {
  const ebml = readHeader(file, 0);
  const segment = readHeader(file, ebml.data + ebml.size);
  const result = { segmentData: segment.data, segmentSize: segment.unknown ? null : segment.size, seek: {}, clusters: [] };
  let pos = segment.data;
  while (pos < file.length) {
    const h = readHeader(file, pos);
    if (h.id === 0x114D9B74) {
      for (const seek of readChildren(file, h.data, h.data + h.size)) {
        if (seek.id === 0xEC) continue;
        const [sid, spos] = readChildren(file, seek.data, seek.data + seek.size);
        result.seek[file.readUIntBE(sid.data, sid.size).toString(16)] = uintAt(file, spos);
      }
    }
    if (h.id === 0x1549A966) {
      const duration = readChildren(file, h.data, h.data + h.size).find((c) => c.id === 0x4489);
      result.duration = duration ? file.readDoubleBE(duration.data) : null;
    }
    if (h.id === 0x1C53BB6B) {
      result.cues = readChildren(file, h.data, h.data + h.size).map((point) => {
        const [time, positions] = readChildren(file, point.data, point.data + point.size);
        const [track, cluster] = readChildren(file, positions.data, positions.data + positions.size);
        return { time: uintAt(file, time), track: uintAt(file, track), position: uintAt(file, cluster) };
      });
    }
    if (h.id === 0x1F43B675) {
      result.clusters.push({ position: pos - segment.data, time: uintAt(file, readHeader(file, h.data)) });
      if (h.unknown) {
        // Children run until the next top-level element.
        let child = h.data;
        while (child < file.length) {
          const c = readHeader(file, child);
          if ([0x1F43B675, 0x1C53BB6B].includes(c.id)) break;
          child = c.data + c.size;
        }
        pos = child;
        continue;
      }
    }
    pos = h.data + h.size;
  }
  return result;
}

const idAt = (file, position) => readHeader(file, position).id;

// ---------- Tests ----------

test('a MediaRecorder-style file gets a duration, a seek index and a known size', () => {
  const { file, plan } = index(recording().bytes);
  const info = inspect(file);
  assert.equal(info.duration, 3030);
  assert.equal(plan.duration, 3030);
  assert.equal(info.segmentSize, file.length - info.segmentData);
  assert.deepEqual(info.cues.map((cue) => [cue.time, cue.track]), [[0, 1], [2005, 1], [3000, 1]]);
  const clusterAt = new Map(info.clusters.map((cluster) => [cluster.position, cluster.time]));
  assert.deepEqual(info.cues.map((cue) => clusterAt.get(cue.position)), [0, 2000, 3000]);
  assert.equal(idAt(file, info.segmentData + info.seek['1c53bb6b']), 0x1C53BB6B);
  assert.equal(idAt(file, info.segmentData + info.seek['1549a966']), 0x1549A966);
  assert.equal(idAt(file, info.segmentData + info.seek['1654ae6b']), 0x1654AE6B);
});

test('everything after the header is written unchanged', () => {
  const { head, bytes } = recording();
  const { written } = index(bytes);
  const body = bytes.subarray(head.length);
  assert.ok(written.subarray(written.length - body.length).equals(body));
  assert.ok(written.length > bytes.length, 'the header grew by the SeekHead and Duration');
});

test('the result does not depend on how the stream is split into chunks', () => {
  const { bytes } = recording();
  const whole = index(bytes).file;
  for (const pieces of [[1], [2, 3], [7], [64], [5, 1, 200, 13], [bytes.length - 1]]) {
    assert.ok(index(bytes, pieces).file.equals(whole), `pieces ${pieces.join(',')}`);
  }
});

test('a file with no video keyframe gets a duration and a void in place of the Cues entry', () => {
  const bytes = Buffer.concat([header(), unknownCluster(0, simpleBlock(2, 0, true), simpleBlock(1, 20, false))]);
  const { file, plan } = index(bytes);
  const info = inspect(file);
  assert.equal(plan.append.length, 0);
  assert.equal(info.duration, 20);
  assert.equal(info.cues, undefined);
  assert.equal(info.seek['1c53bb6b'], undefined);
  assert.equal(idAt(file, info.segmentData + info.seek['1549a966']), 0x1549A966);
  assert.equal(info.segmentSize, file.length - info.segmentData);
});

test('anything unexpected is written unchanged and left without an index', () => {
  const { head, clusters } = recording();
  const cases = {
    'not WebM': Buffer.from('just some bytes that are not a webm file at all'),
    'already indexed': Buffer.concat([head, el(0x1C53BB6B, el(0xBB, uint(0xB3, 0))), ...clusters]),
    'truncated in a block': Buffer.concat([head, ...clusters]).subarray(0, head.length + 200),
    'header only': head,
    'empty': Buffer.alloc(0),
  };
  for (const [name, bytes] of Object.entries(cases)) {
    for (const pieces of [[bytes.length || 1], [3]]) {
      const { written, plan } = index(bytes, pieces);
      assert.equal(plan, null, name);
      if (name !== 'truncated in a block') assert.ok(written.equals(bytes), `${name} is written as it came`);
    }
  }
});

test('a stream cut off before it is finalized is still a valid file with no false length', () => {
  const { head, clusters } = recording();
  const bytes = Buffer.concat([head, ...clusters]);
  for (const cut of [head.length + 200, bytes.length - 5]) {
    const { written, plan } = index(bytes.subarray(0, cut), [97]);
    assert.equal(plan, null);
    // The reserved room is Void: no Duration of 0 and no Cues entry pointing nowhere.
    const ebml = readHeader(written, 0);
    const segment = readHeader(written, ebml.data + ebml.size);
    const top = [];
    for (let pos = segment.data; top.length < 3;) {
      const h = readHeader(written, pos);
      top.push(h);
      pos = h.data + h.size;
    }
    const [seekHead, info] = top;
    assert.equal(seekHead.id, 0x114D9B74);
    const entries = readChildren(written, seekHead.data, seekHead.data + seekHead.size);
    assert.deepEqual(entries.map((entry) => entry.id), [0x4DBB, 0x4DBB, 0xEC]);
    const infoChildren = readChildren(written, info.data, info.data + info.size);
    assert.equal(infoChildren.some((child) => child.id === 0x4489), false);
    assert.equal(infoChildren.at(-1).id, 0xEC);
    assert.ok(segment.unknown, 'the Segment size stays unknown');
  }
});

test('the index is written into the file in place', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-webm-'));
  const filePath = path.join(folder, 'part.webm');
  const indexer = new WebmIndexer();
  fs.writeFileSync(filePath, indexer.push(recording().bytes));
  const plan = indexer.finalize();
  assert.equal(applyIndex(filePath, plan), true);
  assert.equal(inspect(fs.readFileSync(filePath)).duration, 3030);

  // A file of another size is left alone.
  const other = path.join(folder, 'other.webm');
  fs.writeFileSync(other, 'short');
  assert.equal(applyIndex(other, plan), false);
  assert.equal(fs.readFileSync(other, 'utf8'), 'short');
  assert.equal(applyIndex(other, null), false);
});
