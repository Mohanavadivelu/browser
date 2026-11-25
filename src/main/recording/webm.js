'use strict';

// Makes MediaRecorder WebM files seekable while they are written.
//
// Chromium's MediaRecorder writes a live stream: the Segment and every Cluster have an unknown
// size, the Info has no Duration, and there is no SeekHead or Cues index. Players then show no
// length and seek slowly or not at all. Rewriting a finished file to add them would mean copying
// the whole file, so instead WebmIndexer sits between the recorder and the file:
//
// 1. It rewrites the small header once, adding a SeekHead and reserving room (as Void elements,
//    which players skip) for a Duration and for Cues and Chapters entries. Unfinished files stay
//    valid this way.
// 2. It passes every later byte through unchanged, noting where clusters with a video keyframe
//    start and the latest block time.
// 3. finalize() returns a Cues index (and Chapters, for markers set while recording) to append
//    at the end of the file, and a few patches of the same size as the bytes they replace
//    (Duration, the Cues and Chapters entries, the Segment size), written in place. Nothing moves.
//
// Anything it does not expect (an existing index, an unknown-size element other than a Cluster,
// a truncated header) makes it step aside: the bytes pass through untouched and finalize()
// returns null, so the file is exactly what MediaRecorder produced.

const ID = Object.freeze({
  EBML: 0x1A45DFA3,
  Segment: 0x18538067,
  SeekHead: 0x114D9B74,
  Seek: 0x4DBB,
  SeekID: 0x53AB,
  SeekPosition: 0x53AC,
  Info: 0x1549A966,
  Duration: 0x4489,
  Tracks: 0x1654AE6B,
  TrackEntry: 0xAE,
  TrackNumber: 0xD7,
  TrackType: 0x83,
  Cluster: 0x1F43B675,
  Timecode: 0xE7,
  SimpleBlock: 0xA3,
  BlockGroup: 0xA0,
  Block: 0xA1,
  Cues: 0x1C53BB6B,
  CuePoint: 0xBB,
  CueTime: 0xB3,
  CueTrackPositions: 0xB7,
  CueTrack: 0xF7,
  CueClusterPosition: 0xF1,
  Void: 0xEC,
  Chapters: 0x1043A770,
  EditionEntry: 0x45B9,
  EditionUID: 0x45BC,
  ChapterAtom: 0xB6,
  ChapterUID: 0x73C4,
  ChapterTimeStart: 0x91,
  ChapterDisplay: 0x80,
  ChapString: 0x85,
  ChapLanguage: 0x437C,
});
const VIDEO_TRACK_TYPE = 1;
const KEYFRAME_FLAG = 0x80;
// Bytes a block needs before its track, timecode and flags can be read: an 8-byte track number
// at most, plus 2 bytes of timecode and 1 of flags.
const BLOCK_HEADER_MAX = 11;
const MAX_HEADER_BYTES = 1024 * 1024;

// ---------- EBML reading ----------

// Reads a variable-length integer. Returns null if `buf` ends first.
function readVint(buf, pos, keepMarker) {
  if (pos >= buf.length) return null;
  const first = buf[pos];
  let length = 1;
  while (length <= 8 && !(first & (0x80 >> (length - 1)))) length += 1;
  if (length > 8 || pos + length > buf.length) return length > 8 ? { invalid: true } : null;
  const mask = 0xff >> length;
  let value = keepMarker ? first : first & mask;
  let unknown = (first & mask) === mask;
  for (let i = 1; i < length; i += 1) {
    value = value * 256 + buf[pos + i];
    if (buf[pos + i] !== 0xff) unknown = false;
  }
  return { value, length, unknown: !keepMarker && unknown };
}

// Reads an element's ID and size at `pos`. Returns null if the header is not all there yet.
function readElementHeader(buf, pos) {
  const id = readVint(buf, pos, true);
  if (!id) return null;
  if (id.invalid) return { invalid: true };
  const size = readVint(buf, pos + id.length, false);
  if (!size) return null;
  if (size.invalid) return { invalid: true };
  return {
    id: id.value,
    size: size.value,
    unknownSize: size.unknown,
    sizeLength: size.length,
    start: pos,
    dataStart: pos + id.length + size.length,
  };
}

function readUint(buf, start, length) {
  let value = 0;
  for (let i = 0; i < length; i += 1) value = value * 256 + buf[start + i];
  return value;
}

// Children of a master element whose bytes are all in `buf`.
function children(buf, start, end) {
  const result = [];
  let pos = start;
  while (pos < end) {
    const header = readElementHeader(buf, pos);
    if (!header || header.invalid || header.unknownSize || header.dataStart + header.size > end) return null;
    result.push(header);
    pos = header.dataStart + header.size;
  }
  return result;
}

// ---------- EBML writing ----------

function encodeId(id) {
  const bytes = [];
  for (let value = id; value > 0; value = Math.floor(value / 256)) bytes.unshift(value % 256);
  return Buffer.from(bytes);
}

function encodeSize(size, length = 0) {
  let bytes = length;
  if (!bytes) {
    bytes = 1;
    while (size >= 2 ** (7 * bytes) - 1) bytes += 1;
  }
  const out = Buffer.alloc(bytes);
  let value = size;
  for (let i = bytes - 1; i >= 0; i -= 1) {
    out[i] = value % 256;
    value = Math.floor(value / 256);
  }
  out[0] |= 0x80 >> (bytes - 1);
  return out;
}

function encodeUint(value, length = 0) {
  let bytes = length;
  if (!bytes) {
    bytes = 1;
    while (value >= 2 ** (8 * bytes)) bytes += 1;
  }
  const out = Buffer.alloc(bytes);
  let rest = value;
  for (let i = bytes - 1; i >= 0; i -= 1) {
    out[i] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  return out;
}

function element(id, data) {
  return Buffer.concat([encodeId(id), encodeSize(data.length), data]);
}

function uintElement(id, value, length = 0) {
  return element(id, encodeUint(value, length));
}

function seekEntry(id, position) {
  return element(ID.Seek, Buffer.concat([element(ID.SeekID, encodeId(id)), uintElement(ID.SeekPosition, position, 8)]));
}

// Markers as WebM chapters ("Marker 1", "Marker 2", ...), which players such as VLC list.
function chaptersElement(markers) {
  return element(ID.Chapters, element(ID.EditionEntry, Buffer.concat([
    uintElement(ID.EditionUID, 1),
    ...markers.map((ms, i) => element(ID.ChapterAtom, Buffer.concat([
      uintElement(ID.ChapterUID, i + 1),
      uintElement(ID.ChapterTimeStart, ms * 1_000_000), // nanoseconds
      element(ID.ChapterDisplay, Buffer.concat([
        element(ID.ChapString, Buffer.from(`Marker ${i + 1}`)),
        element(ID.ChapLanguage, Buffer.from('eng')),
      ])),
    ]))),
  ])));
}

// A Void element of exactly `length` bytes (at least 2), filled with zeros. Small ones use a
// one-byte size; larger ones an 8-byte size.
function voidOfLength(length) {
  const sizeBytes = length <= 128 ? 1 : Math.min(8, length - 1);
  return Buffer.concat([encodeId(ID.Void), encodeSize(length - 1 - sizeBytes, sizeBytes), Buffer.alloc(length - 1 - sizeBytes)]);
}

// Room reserved for a Duration (ID 2 + size 1 + float 8) and a Seek entry (fixed 21 bytes).
const DURATION_LENGTH = 11;
const SEEK_ENTRY_LENGTH = 21;
// Room reserved before the first cluster for chapters (about 120 markers). Chapters have to come
// before the clusters: written after them (as Cues are), Chromium fails to decode the file.
const CHAPTERS_SPACE = 4096;

// ---------- The indexer ----------

class WebmIndexer {
  constructor() {
    this.state = 'header'; // header -> body, or passthrough when it steps aside
    this.pending = Buffer.alloc(0); // header bytes, or an incomplete element header in the body
    this.written = 0; // bytes handed back for writing so far
    this.skip = 0; // payload bytes still to pass over in the body
    this.segmentDataStart = 0;
    this.segmentSizeAt = -1; // file offset of an 8-byte Segment size, or -1 if it cannot be patched
    this.durationAt = 0; // file offset of the Void reserved for the Duration
    this.cuesSeekAt = 0; // file offset of the Void reserved for the Cues entry in our SeekHead
    this.chaptersSeekAt = 0; // and the one after it, for a Chapters entry
    this.cueTrack = 0;
    this.cluster = null;
    this.cues = [];
    this.lastTime = -1;
  }

  get active() {
    return this.state !== 'passthrough';
  }

  // Takes the next bytes MediaRecorder produced and returns the bytes to write to the file.
  push(chunk) {
    if (this.state === 'passthrough') return this.emit(chunk);
    if (this.state === 'header') {
      this.pending = Buffer.concat([this.pending, chunk]);
      return this.emit(this.tryHeader());
    }
    this.scan(chunk);
    return this.emit(chunk);
  }

  // Bytes held back because the header never completed; written as they came.
  flush() {
    if (this.state !== 'header' || this.pending.length === 0) return Buffer.alloc(0);
    const rest = this.pending;
    this.pending = Buffer.alloc(0);
    this.state = 'passthrough';
    return this.emit(rest);
  }

  emit(bytes) {
    this.written += bytes.length;
    return bytes;
  }

  stepAside() {
    this.state = 'passthrough';
    const rest = this.pending;
    this.pending = Buffer.alloc(0);
    return rest;
  }

  // Rewrites the header once everything up to the first Cluster has arrived.
  tryHeader() {
    const buf = this.pending;
    const ebml = readElementHeader(buf, 0);
    if (!ebml) return Buffer.alloc(0);
    if (ebml.invalid || ebml.id !== ID.EBML || ebml.unknownSize) return this.stepAside();
    const ebmlEnd = ebml.dataStart + ebml.size;
    const segment = readElementHeader(buf, ebmlEnd);
    if (!segment) return this.waitForHeader();
    // A Segment with a known size cannot take an index at its end.
    if (segment.invalid || segment.id !== ID.Segment || !segment.unknownSize) return this.stepAside();

    // Walk the Segment's children up to the first Cluster.
    const parts = [];
    let pos = segment.dataStart;
    for (;;) {
      const child = readElementHeader(buf, pos);
      if (!child) return this.waitForHeader();
      if (child.invalid) return this.stepAside();
      if (child.id === ID.Cluster) break;
      // An existing index means this is not a plain MediaRecorder stream; leave it alone.
      if (child.unknownSize || [ID.SeekHead, ID.Cues].includes(child.id)) return this.stepAside();
      const end = child.dataStart + child.size;
      if (end > buf.length) return this.waitForHeader();
      parts.push(child);
      pos = end;
    }
    const infoIndex = parts.findIndex((part) => part.id === ID.Info);
    const tracks = parts.find((part) => part.id === ID.Tracks);
    if (infoIndex === -1 || !tracks) return this.stepAside();
    const info = parts.at(infoIndex);
    const infoChildren = children(buf, info.dataStart, info.dataStart + info.size);
    if (!infoChildren || infoChildren.some((child) => child.id === ID.Duration)) return this.stepAside();
    this.cueTrack = this.findCueTrack(buf, tracks);
    if (!this.cueTrack) return this.stepAside();

    // New header: EBML, Segment ID and size, our SeekHead, then the original children with a
    // Duration placeholder added to Info. Seek positions are relative to the Segment's data.
    const segmentHead = buf.subarray(ebmlEnd, segment.dataStart);
    const segmentDataStart = segment.dataStart; // EBML and the Segment head keep their length
    const newInfo = element(ID.Info, Buffer.concat([
      buf.subarray(info.dataStart, info.dataStart + info.size),
      voidOfLength(DURATION_LENGTH),
    ]));
    // Every Seek entry has a fixed length, so the SeekHead's length is known before its contents.
    const seekHeadLength = element(ID.SeekHead, Buffer.concat([
      seekEntry(ID.Info, 0), seekEntry(ID.Tracks, 0), voidOfLength(SEEK_ENTRY_LENGTH), voidOfLength(SEEK_ENTRY_LENGTH),
    ])).length;
    const offsets = new Map();
    let relative = seekHeadLength;
    const body = parts.map((part) => {
      const bytes = part === info ? newInfo : buf.subarray(part.start, part.dataStart + part.size);
      offsets.set(part.id, relative);
      if (part === info) this.durationAt = segmentDataStart + relative + newInfo.length - DURATION_LENGTH;
      relative += bytes.length;
      return bytes;
    });
    this.chaptersAt = segmentDataStart + relative;
    body.push(voidOfLength(CHAPTERS_SPACE));
    const seekHead = element(ID.SeekHead, Buffer.concat([
      seekEntry(ID.Info, offsets.get(ID.Info)),
      seekEntry(ID.Tracks, offsets.get(ID.Tracks)),
      voidOfLength(SEEK_ENTRY_LENGTH),
      voidOfLength(SEEK_ENTRY_LENGTH),
    ]));
    this.cuesSeekAt = segmentDataStart + seekHead.length - 2 * SEEK_ENTRY_LENGTH;
    this.chaptersSeekAt = segmentDataStart + seekHead.length - SEEK_ENTRY_LENGTH;
    this.segmentDataStart = segmentDataStart;
    // An 8-byte unknown size can be overwritten with the real size; a shorter one stays unknown.
    if (segment.sizeLength === 8) this.segmentSizeAt = segment.dataStart - 8;

    const header = Buffer.concat([buf.subarray(0, ebmlEnd), segmentHead, seekHead, ...body]);
    const rest = buf.subarray(pos);
    this.pending = Buffer.alloc(0);
    this.state = 'body';
    this.written += header.length; // the body scan below needs file offsets that include it
    this.scan(rest);
    this.written -= header.length;
    return Buffer.concat([header, rest]);
  }

  waitForHeader() {
    // A header this large is not from MediaRecorder; write it as it is.
    return this.pending.length > MAX_HEADER_BYTES ? this.stepAside() : Buffer.alloc(0);
  }

  // The video track gets the index; with no video track, the first track does.
  findCueTrack(buf, tracks) {
    const entries = children(buf, tracks.dataStart, tracks.dataStart + tracks.size);
    if (!entries) return 0;
    let first = 0;
    for (const entry of entries.filter((child) => child.id === ID.TrackEntry)) {
      const fields = children(buf, entry.dataStart, entry.dataStart + entry.size);
      if (!fields) return 0;
      const field = (id) => fields.find((child) => child.id === id);
      const number = field(ID.TrackNumber);
      const type = field(ID.TrackType);
      if (!number) continue;
      const trackNumber = readUint(buf, number.dataStart, number.size);
      first ||= trackNumber;
      if (type && readUint(buf, type.dataStart, type.size) === VIDEO_TRACK_TYPE) return trackNumber;
    }
    return first;
  }

  // Follows the body: Clusters (of any size) holding Timecode, SimpleBlock and BlockGroup.
  // `this.written` is the file offset of the first byte of `chunk`.
  scan(chunk) {
    const buf = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    const base = this.written - this.pending.length;
    this.pending = Buffer.alloc(0);
    let pos = 0;
    while (this.state === 'body') {
      if (this.skip > 0) {
        const step = Math.min(this.skip, buf.length - pos);
        pos += step;
        this.skip -= step;
        if (this.skip > 0) return;
      }
      if (pos >= buf.length) return;
      const header = readElementHeader(buf, pos);
      if (!header) {
        this.pending = Buffer.from(buf.subarray(pos));
        return;
      }
      if (header.invalid) {
        this.state = 'passthrough';
        return;
      }
      const { id } = header;
      if (id === ID.Cluster || id === ID.BlockGroup) {
        // Step into it: its children follow directly, whatever its size.
        if (id === ID.Cluster) this.cluster = { position: base + pos - this.segmentDataStart, time: null, indexed: false };
        pos = header.dataStart;
        continue;
      }
      if (header.unknownSize || [ID.Cues, ID.SeekHead, ID.EBML, ID.Segment].includes(id)) {
        this.state = 'passthrough';
        return;
      }
      if (id === ID.Timecode || id === ID.SimpleBlock || id === ID.Block) {
        const needed = id === ID.Timecode ? header.size : Math.min(header.size, BLOCK_HEADER_MAX);
        if (header.dataStart + needed > buf.length) {
          this.pending = Buffer.from(buf.subarray(pos));
          return;
        }
        if (id === ID.Timecode) {
          if (this.cluster) this.cluster.time = readUint(buf, header.dataStart, header.size);
        } else {
          this.noteBlock(buf, header, id === ID.SimpleBlock);
        }
      }
      pos = header.dataStart;
      this.skip = header.size;
    }
  }

  noteBlock(buf, header, simple) {
    if (!this.cluster || this.cluster.time === null) return;
    const track = readVint(buf, header.dataStart, false);
    if (!track || track.invalid || track.length + 3 > header.size) return;
    const relative = buf.readInt16BE(header.dataStart + track.length);
    const flags = buf[header.dataStart + track.length + 2];
    const time = this.cluster.time + relative;
    this.lastTime = Math.max(this.lastTime, time);
    // A Block inside a BlockGroup has no keyframe flag; only SimpleBlocks are indexed.
    if (simple && !this.cluster.indexed && track.value === this.cueTrack && (flags & KEYFRAME_FLAG)) {
      this.cluster.indexed = true;
      this.cues.push({ time, position: this.cluster.position });
    }
  }

  // What to add once the last byte is written: `append` goes at the end of the file (offset
  // `appendAt`), each patch overwrites bytes in place. Null when the file should be left as it is.
  // `chapters` are marker times in milliseconds; those after the last frame are dropped.
  finalize({ chapters = [] } = {}) {
    if (this.state !== 'body' || this.pending.length || this.skip > 0 || this.lastTime < 0) return null;
    const appendAt = this.written;
    const duration = Buffer.alloc(8);
    duration.writeDoubleBE(this.lastTime);
    const patches = [{ position: this.durationAt, bytes: element(ID.Duration, duration) }];

    let append = Buffer.alloc(0);
    if (this.cues.length) {
      append = element(ID.Cues, Buffer.concat(this.cues.map((cue) => element(ID.CuePoint, Buffer.concat([
        uintElement(ID.CueTime, cue.time),
        element(ID.CueTrackPositions, Buffer.concat([
          uintElement(ID.CueTrack, this.cueTrack),
          uintElement(ID.CueClusterPosition, cue.position),
        ])),
      ])))));
      patches.push({ position: this.cuesSeekAt, bytes: seekEntry(ID.Cues, appendAt - this.segmentDataStart) });
    }
    // With no keyframe there is no index; the reserved entry stays a Void.
    // Markers go into the room reserved before the clusters, as many as fit; the rest of the room
    // stays a Void. (Leaving exactly one byte cannot be filled, so one marker less is kept then.)
    const markers = [...new Set(chapters.map((ms) => Math.round(ms)))]
      .filter((ms) => ms >= 0 && ms <= this.lastTime)
      .sort((a, b) => a - b);
    while (markers.length) {
      const chaptersBytes = chaptersElement(markers);
      const left = CHAPTERS_SPACE - chaptersBytes.length;
      if (left >= 0 && left !== 1) {
        patches.push({ position: this.chaptersAt, bytes: left ? Buffer.concat([chaptersBytes, voidOfLength(left)]) : chaptersBytes });
        patches.push({ position: this.chaptersSeekAt, bytes: seekEntry(ID.Chapters, this.chaptersAt - this.segmentDataStart) });
        break;
      }
      markers.pop();
    }
    if (this.segmentSizeAt >= 0) {
      patches.push({
        position: this.segmentSizeAt,
        bytes: encodeSize(appendAt + append.length - this.segmentDataStart, 8),
      });
    }
    // `duration` is in the file's timecode units: milliseconds for MediaRecorder files.
    return { appendAt, append, patches, duration: this.lastTime, cues: this.cues.length, markers };
  }
}

// Writes the index into a finished file. Leaves the file alone if its size is not what the
// indexer wrote. Returns true when the file was updated.
function applyIndex(filePath, plan, fs = require('node:fs')) {
  if (!plan) return false;
  const fd = fs.openSync(filePath, 'r+');
  try {
    if (fs.fstatSync(fd).size !== plan.appendAt) return false;
    if (plan.append.length) fs.writeSync(fd, plan.append, 0, plan.append.length, plan.appendAt);
    for (const patch of plan.patches) fs.writeSync(fd, patch.bytes, 0, patch.bytes.length, patch.position);
    return true;
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = {
  WebmIndexer, applyIndex, ID, readElementHeader, readVint, readUint, children, element, encodeId, encodeSize,
};
