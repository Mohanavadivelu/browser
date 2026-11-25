'use strict';

// Small WebM files shaped like Chromium's MediaRecorder output, and an independent reader for
// checking what the app writes. Shared by the recording edit tests.

const UNKNOWN = Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);

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

// A SimpleBlock whose payload starts with a marker byte, so tests can tell blocks apart.
function simpleBlock(track, relative, key, marker = 0, payload = 20) {
  const head = Buffer.alloc(4);
  head[0] = 0x80 | track;
  head.writeInt16BE(relative, 1);
  head[3] = key ? 0x80 : 0;
  return el(0xA3, head, Buffer.alloc(payload, marker));
}

function header({ videoCodec = 'V_VP9' } = {}) {
  return Buffer.concat([
    el(0x1A45DFA3, uint(0x4286, 1), el(0x4282, 'webm')),
    Buffer.from([0x18, 0x53, 0x80, 0x67]), UNKNOWN,
    el(0x1549A966, uint(0x2AD7B1, 1000000), el(0x4D80, 'Chrome'), el(0x5741, 'Chrome')),
    el(0x1654AE6B,
      el(0xAE, uint(0xD7, 1), uint(0x83, 1), el(0x86, videoCodec)),
      el(0xAE, uint(0xD7, 2), uint(0x83, 2), el(0x86, 'A_OPUS'))),
  ]);
}

const cluster = (time, ...blocks) => Buffer.concat([Buffer.from([0x1F, 0x43, 0xB6, 0x75]), UNKNOWN, uint(0xE7, time), ...blocks]);

// ---------- Reading ----------

function readVint(buf, pos, keep) {
  const first = buf[pos];
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
  return { id: id.value, size: sz.value, unknown: sz.unknown, data: pos + id.length + sz.length, at: pos };
}

function readChildren(buf, start, end) {
  const list = [];
  for (let pos = start; pos < end;) {
    const h = readHeader(buf, pos);
    list.push(h);
    pos = h.data + h.size;
  }
  return list;
}

const uintAt = (buf, h) => buf.readUIntBE(h.data + Math.max(0, h.size - 6), Math.min(h.size, 6));

// What a player would see: duration, cues, and every block with its track, time, key flag and marker.
function inspect(file) {
  const ebml = readHeader(file, 0);
  const segment = readHeader(file, ebml.data + ebml.size);
  const result = { segmentSize: segment.unknown ? null : segment.size, segmentData: segment.data, seek: {}, blocks: [], clusters: [] };
  let pos = segment.data;
  while (pos < file.length) {
    const h = readHeader(file, pos);
    if (h.id === 0x114D9B74) {
      for (const seek of readChildren(file, h.data, h.data + h.size)) {
        if (seek.id === 0xEC) continue;
        const [sid, spos] = readChildren(file, seek.data, seek.data + seek.size);
        result.seek[file.readUIntBE(sid.data, sid.size).toString(16)] = uintAt(file, spos);
      }
    } else if (h.id === 0x1549A966) {
      const duration = readChildren(file, h.data, h.data + h.size).find((c) => c.id === 0x4489);
      result.duration = duration ? file.readDoubleBE(duration.data) : null;
    } else if (h.id === 0x1C53BB6B) {
      result.cues = readChildren(file, h.data, h.data + h.size).map((point) => {
        const [time, positions] = readChildren(file, point.data, point.data + point.size);
        const [, clusterPos] = readChildren(file, positions.data, positions.data + positions.size);
        return { time: uintAt(file, time), position: uintAt(file, clusterPos) };
      });
    } else if (h.id === 0x1F43B675) {
      let clusterTime = 0;
      result.clusters.push(pos - segment.data);
      let child = h.data;
      const end = h.unknown ? file.length : h.data + h.size;
      while (child < end) {
        const c = readHeader(file, child);
        if ([0x1F43B675, 0x1C53BB6B].includes(c.id)) break;
        if (c.id === 0xE7) clusterTime = uintAt(file, c);
        if (c.id === 0xA3) {
          const track = readVint(file, c.data, false);
          result.blocks.push({
            track: track.value,
            time: clusterTime + file.readInt16BE(c.data + track.length),
            key: Boolean(file[c.data + track.length + 2] & 0x80),
            marker: file[c.data + track.length + 3],
          });
        }
        child = c.data + c.size;
      }
      pos = child;
      continue;
    }
    pos = h.data + h.size;
  }
  return result;
}

module.exports = { header, cluster, simpleBlock, inspect, readHeader };
