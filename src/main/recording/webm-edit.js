'use strict';

const fs = require('node:fs');
const {
  WebmIndexer, applyIndex, ID, readElementHeader, readVint, readUint, children, element, encodeId, encodeSize,
} = require('./webm');

// Cuts and joins WebM recordings without re-encoding.
//
// A recording is read cluster by cluster; the blocks (frames of video and sound) inside the chosen
// time range are written to a new file with their times shifted, so the new file starts at zero
// and the parts of a join follow one another. A cut can only start on a video keyframe, so a trim
// starts at the last keyframe at or before the chosen start (the recorder writes one every 2 s).
// The new file goes through WebmIndexer, so it gets a length and a seek index like a new
// recording. Reading and writing are asynchronous, so a large file does not block the browser.

const READ_CHUNK = 1024 * 1024;
const SEGMENT_UNKNOWN = Buffer.from([0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
// Elements that end a cluster of unknown size when they appear.
const TOP_LEVEL = new Set([
  ID.Cluster, ID.Cues, ID.SeekHead, ID.Info, ID.Tracks,
  0x1254C367, // Tags
  0x1043A770, // Chapters
  0x1941A469, // Attachments
]);
const TRACK_ENTRY_FIELDS = Object.freeze({ number: ID.TrackNumber, type: ID.TrackType, codec: 0x86 });
const VIDEO = 1;
// Time left between joined parts, about one video frame, so their frames do not overlap.
const JOIN_GAP = 33;
const MAX_RELATIVE = 32767;

// Reads a file forward, a megabyte at a time.
class FileReader {
  constructor(handle) {
    this.handle = handle;
    this.buf = Buffer.alloc(0);
    this.offset = 0; // file offset of buf[0]
    this.eof = false;
  }

  static async open(filePath) {
    return new FileReader(await fs.promises.open(filePath, 'r'));
  }

  async ensure(count) {
    while (this.buf.length < count && !this.eof) {
      const chunk = Buffer.alloc(Math.max(READ_CHUNK, count - this.buf.length));
      const { bytesRead } = await this.handle.read(chunk, 0, chunk.length, this.offset + this.buf.length);
      if (bytesRead === 0) this.eof = true;
      else this.buf = Buffer.concat([this.buf, chunk.subarray(0, bytesRead)]);
    }
    return this.buf.length >= count;
  }

  consume(count) {
    this.buf = this.buf.subarray(count);
    this.offset += count;
  }

  // The next element's header, or null at the end of the file (or of a cut-off file).
  async header() {
    await this.ensure(12);
    const header = this.buf.length ? readElementHeader(this.buf, 0) : null;
    if (!header || header.invalid) return null;
    this.consume(header.dataStart);
    return header;
  }

  // The next `count` bytes, or null if the file ends first.
  async take(count) {
    if (!(await this.ensure(count))) return null;
    const bytes = Buffer.from(this.buf.subarray(0, count));
    this.consume(count);
    return bytes;
  }

  async skip(count) {
    if (count <= this.buf.length) {
      this.consume(count);
      return;
    }
    this.offset += count;
    this.buf = Buffer.alloc(0);
  }

  close() {
    return this.handle.close();
  }
}

// The tracks of a recording: [{ number, type, codec }].
function readTracks(data) {
  const entries = children(data, 0, data.length) ?? [];
  return entries.filter((entry) => entry.id === ID.TrackEntry).map((entry) => {
    const fields = children(data, entry.dataStart, entry.dataStart + entry.size) ?? [];
    const read = (id, asText) => {
      const field = fields.find((child) => child.id === id);
      if (!field) return null;
      return asText ? data.toString('latin1', field.dataStart, field.dataStart + field.size) : readUint(data, field.dataStart, field.size);
    };
    return { number: read(TRACK_ENTRY_FIELDS.number), type: read(TRACK_ENTRY_FIELDS.type), codec: read(TRACK_ENTRY_FIELDS.codec, true) };
  });
}

// Opens a recording and reads everything before its first cluster.
async function openRecording(filePath) {
  const reader = await FileReader.open(filePath);
  try {
    const ebml = await reader.header();
    if (ebml?.id !== ID.EBML) throw new Error('not a WebM recording');
    const ebmlBytes = Buffer.concat([encodeId(ID.EBML), encodeSize(ebml.size), await reader.take(ebml.size)]);
    const segment = await reader.header();
    if (segment?.id !== ID.Segment) throw new Error('not a WebM recording');
    const segmentEnd = segment.unknownSize ? Infinity : reader.offset + segment.size;
    let info = null;
    let tracks = null;
    for (;;) {
      const header = await reader.header();
      if (!header) throw new Error('the recording has no video');
      if (header.id === ID.Cluster) {
        if (!info || !tracks) throw new Error('the recording is missing its track list');
        return { reader, ebml: ebmlBytes, info, tracks, trackList: readTracks(tracks.data), firstCluster: header, segmentEnd };
      }
      if (header.unknownSize) throw new Error('unexpected layout');
      if (header.id === ID.Info || header.id === ID.Tracks) {
        const data = await reader.take(header.size);
        if (!data) throw new Error('the recording is cut off');
        if (header.id === ID.Info) {
          // Without its Duration (and any reserved room): the new file gets its own.
          const kept = (children(data, 0, data.length) ?? [])
            .filter((child) => child.id !== ID.Duration && child.id !== ID.Void)
            .map((child) => data.subarray(child.start, child.dataStart + child.size));
          info = element(ID.Info, Buffer.concat(kept));
        } else {
          tracks = { bytes: element(ID.Tracks, data), data };
        }
      } else {
        await reader.skip(header.size); // SeekHead, Void, Tags, Cues and the like
      }
    }
  } catch (error) {
    await reader.close();
    throw error;
  }
}

// A block's track, its time within the cluster, and whether it is a keyframe.
function blockInfo(data, simple) {
  const track = readVint(data, 0, false);
  if (!track || track.invalid || data.length < track.length + 3) return null;
  return {
    track: track.value,
    relativeAt: track.length,
    relative: data.readInt16BE(track.length),
    key: simple && Boolean(data[track.length + 2] & 0x80),
  };
}

// Every cluster of an opened recording: { time, blocks: [{ id, data, time, track, key, relativeAt }] }.
// For a BlockGroup, `relativeAt` points into the Block inside it. A cut-off end is ignored.
async function* readClusters(recording) {
  const { reader } = recording;
  let header = recording.firstCluster;
  while (header) {
    if (header.id !== ID.Cluster) {
      if (header.unknownSize) return;
      await reader.skip(header.size);
      header = reader.offset < recording.segmentEnd ? await reader.header() : null;
      continue;
    }
    const end = header.unknownSize ? Infinity : reader.offset + header.size;
    const cluster = { time: 0, blocks: [] };
    let next = null;
    let cutOff = false;
    while (reader.offset < end) {
      const child = await reader.header();
      if (!child) {
        cutOff = true; // the end of the file (or of a cut-off one)
        break;
      }
      if (TOP_LEVEL.has(child.id)) {
        next = child;
        break;
      }
      if (child.unknownSize) {
        cutOff = true;
        break;
      }
      const wanted = child.id === ID.Timecode || child.id === ID.SimpleBlock || child.id === ID.BlockGroup;
      const data = wanted ? await reader.take(child.size) : null;
      if (wanted && !data) {
        cutOff = true;
        break;
      }
      if (child.id === ID.Timecode) {
        cluster.time = readUint(data, 0, data.length);
      } else if (child.id === ID.SimpleBlock) {
        const info = blockInfo(data, true);
        if (info) cluster.blocks.push({ id: ID.SimpleBlock, data, ...info, time: cluster.time + info.relative });
      } else if (child.id === ID.BlockGroup) {
        const block = (children(data, 0, data.length) ?? []).find((part) => part.id === ID.Block);
        const info = block && blockInfo(data.subarray(block.dataStart, block.dataStart + block.size), false);
        if (info) cluster.blocks.push({ id: ID.BlockGroup, data, ...info, relativeAt: block.dataStart + info.relativeAt, time: cluster.time + info.relative });
      } else {
        await reader.skip(child.size);
      }
    }
    if (cluster.blocks.length) yield cluster;
    if (cutOff) return;
    if (next) header = next;
    else header = reader.offset < recording.segmentEnd ? await reader.header() : null;
  }
}

// Times of the video keyframes in a recording, in order.
async function keyframeTimes(filePath) {
  const recording = await openRecording(filePath);
  try {
    const video = recording.trackList.find((track) => track.type === VIDEO)?.number;
    const times = [];
    for await (const cluster of readClusters(recording)) {
      for (const block of cluster.blocks) if (block.key && block.track === video) times.push(block.time);
    }
    return times;
  } finally {
    await recording.reader.close();
  }
}

function sameFormat(a, b) {
  const key = (tracks) => JSON.stringify(tracks.map(({ number, type, codec }) => [number, type, codec]).sort());
  return key(a) === key(b);
}

// Writes `pieces` one after another into a new file at `outPath` (which must not exist):
// [{ path, from = 0, to = Infinity }], times in milliseconds of each source. Returns
// { durationMs, startMs } (startMs: where the first piece really starts, on a keyframe).
async function writeRecording(outPath, pieces) {
  const indexer = new WebmIndexer();
  const out = await fs.promises.open(outPath, 'wx');
  let written = 0;
  const emit = async (bytes) => {
    const ready = indexer.push(bytes);
    if (ready.length) {
      await out.write(ready, 0, ready.length, written);
      written += ready.length;
    }
  };
  try {
    let format = null;
    let offset = 0;
    let firstStart = null;
    for (const piece of pieces) {
      const keyframes = await keyframeTimes(piece.path);
      if (keyframes.length === 0) throw new Error('the recording has no keyframe to start from');
      const from = piece.from ?? 0;
      const to = piece.to ?? Infinity;
      const start = [...keyframes].reverse().find((time) => time <= from) ?? keyframes[0];
      firstStart ??= start;
      const recording = await openRecording(piece.path);
      try {
        if (!format) {
          format = recording.trackList;
          await emit(Buffer.concat([recording.ebml, SEGMENT_UNKNOWN, recording.info, recording.tracks.bytes]));
        } else if (!sameFormat(format, recording.trackList)) {
          throw new Error('the parts were recorded in different formats');
        }
        let last = offset;
        for await (const cluster of readClusters(recording)) {
          if (cluster.time > to) break;
          const kept = cluster.blocks.filter((block) => block.time >= start && block.time <= to);
          if (kept.length === 0) continue;
          const times = kept.map((block) => block.time - start + offset);
          // A new cluster wherever the times would not fit a block's 16-bit offset.
          let clusterTime = null;
          const parts = [];
          const flush = async () => {
            if (parts.length) await emit(Buffer.concat([encodeId(ID.Cluster), encodeSize(0, 8).fill(0xff, 1), element(ID.Timecode, uintBytes(clusterTime)), ...parts]));
            parts.length = 0;
          };
          for (let i = 0; i < kept.length; i += 1) {
            const time = times[i];
            if (clusterTime === null || time - clusterTime > MAX_RELATIVE || time < clusterTime) {
              await flush();
              clusterTime = Math.min(...times.slice(i));
            }
            const data = Buffer.from(kept[i].data);
            data.writeInt16BE(time - clusterTime, kept[i].relativeAt);
            parts.push(element(kept[i].id, data));
            last = Math.max(last, time);
          }
          await flush();
        }
        offset = last + JOIN_GAP;
      } finally {
        await recording.reader.close();
      }
    }
    const rest = indexer.flush();
    if (rest.length) {
      await out.write(rest, 0, rest.length, written);
      written += rest.length;
    }
    const plan = indexer.finalize();
    await out.close();
    if (!plan || !applyIndex(outPath, plan)) throw new Error('nothing was left to save');
    return { durationMs: plan.duration, startMs: firstStart };
  } catch (error) {
    await out.close().catch(() => {});
    fs.rmSync(outPath, { force: true });
    throw error;
  }
}

function uintBytes(value) {
  const bytes = [];
  let rest = value;
  do {
    bytes.unshift(rest % 256);
    rest = Math.floor(rest / 256);
  } while (rest > 0);
  return Buffer.from(bytes);
}

module.exports = { writeRecording, keyframeTimes, openRecording, readClusters };
