'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { isAllowedUrl } = require('./security/navigation');
const { RateLimiter, PART_SUFFIX } = require('./segmented-download');

const MAX_TRACKED = 100;
const SAVE_DELAY_MS = 1000;
const MISSING_CHECK_MS = 5000;
const STORE_VERSION = 1;
const STATES = new Set(['progressing', 'paused', 'queued', 'interrupted', 'completed', 'cancelled', 'blocked']);
// Waiting to finish: these keep their place among the downloads that count against the limit.
const UNFINISHED = new Set(['progressing', 'paused', 'queued']);
const FINISHED = new Set(['completed', 'cancelled', 'blocked']);
const KINDS = new Set(['file', 'video', 'audio']);
const MAX_TEXT = 2048;
// Chromium deletes the partial file of a download still running when the browser quits. A
// second name for the file (a hard link) keeps its bytes until the next start.
const KEPT_SUFFIX = '.sbdownload';
const MAX_COPY_BYTES = 256 * 1024 * 1024; // when a link can't be made, a copy up to this size
// Downloads at least this big are split over several connections, when the server allows it.
const SPLIT_FROM_BYTES = 4 * 1024 * 1024;
const MAX_PARTS = 32;
// How often the speed limit checks the downloads Chromium runs itself.
const THROTTLE_TICK_MS = 100;
// How often waiting downloads with a start time (or for the night) are looked at.
const SCHEDULE_TICK_MS = 15 * 1000;
// A download asked for that hasn't begun by then (refused, or the address failed) has failed.
const START_TIMEOUT_MS = 30 * 1000;
const MAX_ADD = 50;
const SHA256 = /^[0-9a-f]{64}$/;
const CHECKSUM_RESULTS = new Set(['', 'checking', 'match', 'mismatch', 'error']);

const text = (value, max = MAX_TEXT) => (typeof value === 'string' && value.length <= max ? value : '');
const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0);

// A saved entry from downloads.json, or null if it is not one this version would have written.
function sanitizeEntry(raw) {
  if (raw === null || typeof raw !== 'object') return null;
  const url = text(raw.url);
  const savePath = text(raw.path);
  const filename = text(raw.filename, 260);
  if (!isAllowedUrl(url) || !filename || (savePath && !path.isAbsolute(savePath))) return null;
  const urlChain = Array.isArray(raw.urlChain) ? raw.urlChain.filter((link) => typeof link === 'string' && link.length <= MAX_TEXT && isAllowedUrl(link)).slice(0, 20) : [];
  return {
    filename,
    path: savePath,
    url,
    urlChain: urlChain.length ? urlChain : [url],
    mimeType: text(raw.mimeType, 200),
    etag: text(raw.etag, 500),
    lastModified: text(raw.lastModified, 200),
    startTime: Number.isFinite(raw.startTime) && raw.startTime > 0 ? raw.startTime : 0,
    state: STATES.has(raw.state) ? raw.state : 'interrupted',
    received: count(raw.received),
    total: count(raw.total),
    startedAt: count(raw.startedAt),
    finishedAt: count(raw.finishedAt),
    kind: KINDS.has(raw.kind) ? raw.kind : 'file',
    openWhenDone: raw.openWhenDone === true,
    // The kept copy is always next to the file, by this name: the list can't point elsewhere.
    kept: raw.kept === true && Boolean(savePath),
    parts: sanitizeParts(raw.parts, count(raw.total)),
    // Added from the Add links dialog: the folder it goes into, when it may start, and whether
    // it waits for the schedule (a start time, or the night) before it starts.
    saveDir: typeof raw.saveDir === 'string' && raw.saveDir.length <= MAX_TEXT && path.isAbsolute(raw.saveDir) ? raw.saveDir : '',
    startAt: count(raw.startAt),
    deferred: raw.deferred === true,
    order: Number.isFinite(raw.order) ? raw.order : 0,
    checksum: sanitizeChecksum(raw.checksum),
  };
}

function sanitizeChecksum(raw) {
  const expected = typeof raw?.expected === 'string' ? raw.expected.trim().toLowerCase() : '';
  if (!SHA256.test(expected)) return null;
  // A check that was running when the browser closed runs again.
  return { expected, result: CHECKSUM_RESULTS.has(raw.result) && raw.result !== 'checking' ? raw.result : '' };
}

// A checksum typed or pasted by the user: 64 hex digits, any case, spaces around allowed.
function parseChecksum(value) {
  const hex = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return SHA256.test(hex) ? hex : '';
}

// The SHA-256 of a file, read as a stream (big files too).
function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(filePath)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

// A name in `dir` no other file (or download on the list) has: "report (2).pdf" if need be.
function uniquePath(dir, filename, taken) {
  const safe = path.win32.basename(filename).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '') || 'download';
  const ext = path.extname(safe);
  const stem = safe.slice(0, safe.length - ext.length);
  for (let n = 1; n < 1000; n += 1) {
    const candidate = path.join(dir, n === 1 ? safe : `${stem} (${n})${ext}`);
    const lower = candidate.toLowerCase();
    if (!fs.existsSync(candidate) && !fs.existsSync(`${candidate}${PART_SUFFIX}`) && !taken.has(lower)) return candidate;
  }
  return path.join(dir, `${stem} (${Date.now()})${ext}`);
}

// The parts of a download split over several connections: [start, end, position] each, in the
// file and in order, or null.
function sanitizeParts(raw, total) {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_PARTS || total === 0) return null;
  const parts = [];
  for (const part of raw) {
    if (!Array.isArray(part) || part.length !== 3 || !part.every((value) => Number.isSafeInteger(value) && value >= 0)) return null;
    const [start, end, pos] = part;
    if (start > end || end >= total || pos < start || pos > end + 1) return null;
    parts.push([start, end, pos]);
  }
  return parts;
}

// Where a download's unfinished bytes are: its own file for Chromium's downloads, a file next
// to it for one split over several connections.
const partialFileOf = (entry) => (entry.parts ? `${entry.path}${PART_SUFFIX}` : entry.path);

// Puts a partial file kept at the last shutdown back under its own name.
function recoverKept(entry) {
  if (!entry.kept) return;
  entry.kept = false;
  const kept = `${entry.path}${KEPT_SUFFIX}`;
  try {
    if (!fs.existsSync(kept)) return;
    if (fs.existsSync(entry.path)) fs.rmSync(kept, { force: true });
    else fs.renameSync(kept, entry.path);
  } catch (error) {
    console.error(`Could not recover a partial download: ${error.message}`);
  }
}

// Gives a running download's partial file a second name, so it outlives Chromium's clean-up.
function keepPartial(filePath) {
  const kept = `${filePath}${KEPT_SUFFIX}`;
  try {
    fs.rmSync(kept, { force: true });
    fs.linkSync(filePath, kept);
    return true;
  } catch {
    try {
      if (fileSize(filePath) > MAX_COPY_BYTES) return false;
      fs.copyFileSync(filePath, kept);
      return true;
    } catch {
      return false;
    }
  }
}

// The downloads list: progress, pause and resume, a queue that lets only so many run at once,
// retrying failed downloads, and (outside private tabs) a list kept in the profile so that
// unfinished downloads pick up where they left off after the browser restarts.
//
// Options (all optional): `storePath`, the JSON file the list is kept in; `maxActive()`, how
// many may download at once; `startDownload(url)`, starts a download of `url` in the regular
// profile (for a retry that starts over); `createInterrupted(options)`, Electron's
// session.createInterruptedDownload in the regular profile (for resuming a saved download);
// `speedLimit()`, bytes a second for all downloads together (0: no limit); `segmented`, for
// splitting big downloads over several connections: { connections(), probe(details),
// create(details) }, where probe resolves true when the server answers Range requests for the
// file and create returns a SegmentedDownload (see segmented-download.js).
// Electron's DownloadItems are handed in with track(), from the session's will-download.
class DownloadManager extends EventEmitter {
  constructor({ storePath = null, maxActive = () => 3, startDownload = null, createInterrupted = null, speedLimit = () => 0, segmented = null,
    nightWindow = () => null, now = Date.now } = {}) {
    super();
    // `nightWindow()`: null, or { from, to } in minutes after midnight, when waiting downloads
    // added to the queue may start (the window can run past midnight).
    this.nightWindow = nightWindow;
    this.scheduleTimer = null;
    this.nextOrder = 1;
    this.storePath = storePath;
    this.maxActive = maxActive;
    this.startDownload = startDownload;
    this.createInterrupted = createInterrupted;
    this.segmented = segmented;
    this.limiter = new RateLimiter(speedLimit, now);
    this.throttleTimer = null;
    this.now = now;
    this.records = new Map(); // id -> { entry, item, started, missingAt }
    this.nextId = 1;
    this.expected = new Map(); // first address -> { entryId?, kind?, savePath? }
    this.restoring = new Map(); // save path -> entry id
    this.saveTimer = null;
    this.closed = false;
    this.startedThisRun = false;
  }

  // ---------- The saved list ----------
  // Unfinished downloads from last time come back paused, without a DownloadItem; resumeSaved()
  // starts the ones that were downloading or waiting when the browser closed.
  load() {
    if (!this.storePath) return 0;
    let saved;
    try {
      saved = JSON.parse(fs.readFileSync(this.storePath, 'utf8'));
    } catch {
      return 0;
    }
    const entries = Array.isArray(saved?.entries) ? saved.entries : [];
    let unfinished = 0;
    for (const raw of entries.slice(0, MAX_TRACKED).reverse()) {
      const clean = sanitizeEntry(raw);
      if (!clean) continue;
      recoverKept(clean);
      // Added to the queue and not started yet: it goes on waiting for its turn or its time.
      const waiting = clean.state === 'queued' && clean.deferred && clean.received === 0;
      const wasRunning = !waiting && (clean.state === 'progressing' || clean.state === 'queued');
      if (UNFINISHED.has(clean.state) && !waiting) {
        clean.state = 'paused';
        unfinished += 1;
      }
      const entry = { id: this.nextId++, ...clean, speed: 0, isPrivate: false, restored: UNFINISHED.has(raw.state) && !waiting };
      this.nextOrder = Math.max(this.nextOrder, Math.ceil(entry.order) + 1);
      this.records.set(entry.id, { entry, item: null, started: false, wasRunning, missingAt: 0 });
    }
    this.schedule();
    return unfinished;
  }

  scheduleSave() {
    if (!this.storePath || this.closed || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, SAVE_DELAY_MS);
    this.saveTimer.unref?.();
  }

  save() {
    if (!this.storePath) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const entries = [...this.records.values()].reverse()
      .filter(({ entry }) => !entry.isPrivate)
      .map(({ entry, item }) => {
        const live = item && UNFINISHED.has(entry.state) ? { received: item.getReceivedBytes() } : {};
        const { id: _id, speed: _speed, isPrivate: _private, restored: _restored, connections: _connections, ...saved } = entry;
        return { ...saved, ...live };
      });
    const temporary = `${this.storePath}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
      fs.writeFileSync(temporary, JSON.stringify({ version: STORE_VERSION, entries }));
      fs.renameSync(temporary, this.storePath);
    } catch (error) {
      console.error(`Could not save the downloads list: ${error.message}`);
      try {
        fs.rmSync(temporary, { force: true });
      } catch {
        // Nothing more to do.
      }
    }
  }

  // The browser is closing: the list is saved as it is now, before Chromium interrupts what is
  // still downloading (deleting its partial file, so that is kept under a second name first),
  // and is not written again.
  shutdown() {
    if (this.closed) return;
    for (const { entry, item } of this.records.values()) {
      const unfinished = UNFINISHED.has(entry.state) || (entry.state === 'interrupted' && item?.canResume?.());
      if (!item || !unfinished || entry.isPrivate) continue;
      entry.received = item.getReceivedBytes();
      // A download split over connections writes its own file, which Chromium leaves alone.
      if (item.isSegmented) entry.parts = item.getParts();
      else if (entry.path && fileSize(entry.path) > 0) entry.kept = keepPartial(entry.path);
    }
    this.save();
    this.closed = true;
    clearInterval(this.throttleTimer);
    clearInterval(this.scheduleTimer);
  }

  // Starts the saved downloads that were downloading or waiting when the browser closed.
  resumeSaved() {
    let resumed = 0;
    for (const record of this.records.values()) {
      if (!record.item && record.wasRunning && record.entry.state === 'paused') {
        record.wasRunning = false;
        if (this.resume(record.entry.id)) resumed += 1;
      }
    }
    return resumed;
  }

  // ---------- Downloads starting ----------
  // The next download of `url` is the one asked for here: a saved video, or a retry of an
  // existing entry (into the same file).
  expect(url, details = {}) {
    if (isAllowedUrl(url)) this.expected.set(url, details);
  }

  // Where a download should be saved without asking: a retry goes back into its own file, and
  // a link added with a folder goes into that folder, under a name not yet taken there.
  presetPath(item) {
    if (item.getSavePath()) return '';
    const expected = this.expected.get(firstUrl(item));
    if (expected?.savePath) return expected.savePath;
    if (!expected?.saveDir) return '';
    const taken = new Set([...this.records.values()].map(({ entry }) => entry.path.toLowerCase()).filter(Boolean));
    expected.savePath = uniquePath(expected.saveDir, item.getFilename(), taken);
    return expected.savePath;
  }

  // `session` is the item's own session, for the connections of a split download.
  track(item, { isPrivate = false, session = null } = {}) {
    const url = firstUrl(item);
    const expected = this.expected.get(url);
    if (expected) this.expected.delete(url);
    const restoringId = this.restoring.get(item.getSavePath());
    if (restoringId) this.restoring.delete(item.getSavePath());
    const adoptId = restoringId ?? expected?.entryId;
    let record = adoptId ? this.records.get(adoptId) : null;

    if (record) {
      clearTimeout(record.startTimer);
      record.item = item;
      record.started = true;
      record.session = session;
      record.checkedSplit = false;
      // The name the server gave, now that it is known.
      if (expected?.saveDir) record.entry.filename = item.getFilename() || record.entry.filename;
      Object.assign(record.entry, { state: 'progressing', speed: 0, received: item.getReceivedBytes(), finishedAt: 0, restored: Boolean(restoringId) || record.entry.restored });
    } else {
      const entry = {
        id: this.nextId++,
        filename: item.getFilename(),
        path: item.getSavePath() || '',
        url: url || (item.getURL?.() ?? ''),
        urlChain: chainOf(item),
        mimeType: item.getMimeType?.() ?? '',
        etag: '',
        lastModified: '',
        startTime: 0,
        state: 'progressing',
        received: 0,
        total: item.getTotalBytes(),
        speed: 0,
        startedAt: this.now(),
        finishedAt: 0,
        kind: expected?.kind && KINDS.has(expected.kind) ? expected.kind : 'file',
        openWhenDone: false,
        kept: false,
        parts: null,
        saveDir: '',
        startAt: 0,
        deferred: false,
        order: this.nextOrder++,
        checksum: null,
        isPrivate,
        restored: false,
      };
      record = { entry, item, started: false, wasRunning: false, missingAt: 0, session, checkedSplit: false, throttled: false };
      this.records.set(entry.id, record);
      this.trim();
      this.emit('started', { ...entry });
    }
    this.startedThisRun = true;
    this.wire(record, item);
    // A saved download is created interrupted, and only goes on when it is resumed.
    if (restoringId) setImmediate(() => { if (record.item === item && item.getState?.() === 'interrupted') item.resume(); });
    this.changed();
    return record.entry.id;
  }

  wire(record, item) {
    const { entry } = record;
    // The download policy refused the name chosen in the Save dialog.
    item.once('blocked', () => {
      if (record.item !== item) return;
      entry.state = 'blocked';
      this.changed();
    });
    item.on('updated', (_event, state) => {
      if (record.item !== item || entry.state === 'blocked') return;
      this.copyDetails(entry, item);
      if (state === 'interrupted') {
        const was = entry.state;
        entry.state = 'interrupted';
        // A failed download makes room for a waiting one.
        if (was === 'progressing') setImmediate(() => this.pump());
      } else if (entry.state !== 'queued' && !(record.throttled && item.isPaused())) {
        // Paused by the speed limit, it is still downloading as far as the user is concerned.
        entry.state = item.isPaused() ? 'paused' : 'progressing';
      }
      // Once its file is chosen, a new download waits its turn if enough are running already.
      // (Pausing from inside the item's own event would re-enter Chromium's observer list.)
      if (!record.started && entry.path && entry.state === 'progressing') {
        record.started = true;
        if (this.activeCount(entry.id) >= this.maxActive()) {
          entry.state = 'queued';
          entry.speed = 0;
          setImmediate(() => { if (record.item === item && entry.state === 'queued') item.pause(); });
        }
      }
      if (record.started && entry.state === 'progressing' && !record.checkedSplit && !item.isSegmented && entry.path) this.trySplit(record, item);
      this.throttle();
      this.changed();
    });
    item.once('done', (_event, state) => {
      if (record.item !== item) return;
      this.copyDetails(entry, item);
      entry.speed = 0;
      if (entry.state !== 'blocked') entry.state = state;
      entry.finishedAt = this.now();
      if (entry.state !== 'interrupted') record.item = null;
      this.changed();
      if (entry.state === 'completed') {
        this.emit('completed', { ...entry });
        if (entry.checksum) this.verify(record);
      }
      this.pump();
    });
  }

  copyDetails(entry, item) {
    if (item.isSegmented) {
      entry.parts = item.getParts();
      entry.connections = item.getActiveConnections();
    } else {
      entry.connections = 0;
    }
    entry.received = item.getReceivedBytes();
    entry.total = item.getTotalBytes();
    entry.path = item.getSavePath() || entry.path;
    entry.speed = item.isPaused() ? 0 : Math.max(0, Math.round(item.getCurrentBytesPerSecond?.() ?? 0));
    entry.urlChain = chainOf(item);
    entry.mimeType = item.getMimeType?.() || entry.mimeType;
    entry.etag = item.getETag?.() || entry.etag;
    entry.lastModified = item.getLastModifiedTime?.() || entry.lastModified;
    entry.startTime = item.getStartTime?.() || entry.startTime;
  }

  changed() {
    this.emit('change');
    this.scheduleSave();
  }

  // ---------- Several connections ----------
  // A big download whose server answers Range requests for the same file is handed over to a
  // SegmentedDownload, which fetches its parts at once. Chromium's own download is cancelled
  // (that deletes its file; the new one writes a file of its own next to it). Anything that
  // doesn't match leaves the download with Chromium.
  async trySplit(record, item) {
    record.checkedSplit = true;
    const { entry } = record;
    const connections = this.segmented?.connections() ?? 1;
    if (connections < 2 || entry.total < SPLIT_FROM_BYTES) return;
    const details = {
      session: record.session,
      isPrivate: entry.isPrivate,
      url: entry.urlChain.at(-1) || entry.url,
      urlChain: entry.urlChain,
      filename: entry.filename,
      savePath: entry.path,
      total: entry.total,
      etag: entry.etag,
      lastModified: entry.lastModified,
      mimeType: entry.mimeType,
      startTime: entry.startTime,
      connections,
      limiter: this.limiter,
    };
    let split = null;
    try {
      if (!(await this.segmented.probe(details))) return;
      if (record.item !== item || entry.state !== 'progressing') return;
      split = this.segmented.create(details);
    } catch {
      return;
    }
    record.item = split;
    record.throttled = false;
    item.cancel();
    this.wire(record, split);
    split.start();
    this.copyDetails(entry, split);
    this.changed();
  }

  // ---------- The speed limit ----------
  // Split downloads wait for their share as they read. Chromium's own downloads can't be told
  // a speed, so they are paused while all downloads together are over the limit, and resumed
  // as the allowance builds up again.
  throttle() {
    if (this.throttleTimer || this.closed || !this.limiter.refill()) return;
    this.throttleTimer = setInterval(() => this.throttleTick(), THROTTLE_TICK_MS);
    this.throttleTimer.unref?.();
    this.throttleTick();
  }

  throttleTick() {
    const plain = [...this.records.values()].filter(({ entry, item }) => item && !item.isSegmented && entry.state === 'progressing');
    if (plain.length === 0 || !this.limiter.refill()) {
      // No limit (any more): what the limit paused goes on.
      for (const record of plain) {
        if (record.throttled) {
          record.throttled = false;
          record.item.resume();
        }
      }
      clearInterval(this.throttleTimer);
      this.throttleTimer = null;
      return;
    }
    for (const record of plain) {
      const received = record.item.getReceivedBytes();
      this.limiter.consume(Math.max(0, received - (record.counted ?? received)));
      record.counted = received;
    }
    const over = this.limiter.overBudget;
    for (const record of plain) {
      if (over && !record.throttled && !record.item.isPaused()) {
        record.throttled = true;
        record.item.pause();
      } else if (!over && record.throttled) {
        record.throttled = false;
        record.item.resume();
      }
    }
  }

  // ---------- The queue ----------
  // Downloads running now. One still waiting for its file to be chosen doesn't count yet.
  activeCount(exceptId) {
    let active = 0;
    for (const { entry, started } of this.records.values()) if (started && entry.state === 'progressing' && entry.id !== exceptId) active += 1;
    return active;
  }

  // Starts waiting downloads in their order (the user can drag it), while there is room. One
  // added to the queue from Add links also waits for its start time and the night, if set.
  pump() {
    const waiting = this.queue();
    let started = false;
    for (const record of waiting) {
      if (this.activeCount() >= this.maxActive()) break;
      if (record.item) {
        record.entry.state = 'progressing';
        record.item.resume();
        started = true;
      } else if (this.mayStart(record.entry)) {
        this.startWaiting(record);
        started = true;
      }
    }
    if (started) this.changed();
    this.schedule();
  }

  queue() {
    return [...this.records.values()].filter(({ entry }) => entry.state === 'queued').sort((a, b) => a.entry.order - b.entry.order);
  }

  // Whether a download added to the queue may start now: its start time has come, and (when
  // the night setting is on) it is night.
  mayStart(entry, now = this.now()) {
    if (!entry.deferred) return true;
    if (entry.startAt > now) return false;
    return entry.startAt > 0 || this.inNightWindow(now);
  }

  inNightWindow(now = this.now()) {
    const window = this.nightWindow();
    if (!window) return true;
    const date = new Date(now);
    const minutes = date.getHours() * 60 + date.getMinutes();
    return window.from <= window.to ? minutes >= window.from && minutes < window.to : minutes >= window.from || minutes < window.to;
  }

  // Looks at waiting downloads every few seconds while some wait for a time.
  schedule() {
    const timed = [...this.records.values()].some(({ entry, item }) => entry.state === 'queued' && !item && entry.deferred);
    if (timed && !this.scheduleTimer && !this.closed) {
      this.scheduleTimer = setInterval(() => this.pump(), SCHEDULE_TICK_MS);
      this.scheduleTimer.unref?.();
    } else if (!timed && this.scheduleTimer) {
      clearInterval(this.scheduleTimer);
      this.scheduleTimer = null;
    }
  }

  startWaiting(record) {
    const { entry } = record;
    if (entry.isPrivate || !this.startDownload) return false;
    record.started = true; // counts against the limit while Chromium starts it
    this.expect(entry.url, { entryId: entry.id, savePath: entry.path, saveDir: entry.saveDir, kind: entry.kind });
    Object.assign(entry, { state: 'progressing', received: 0, speed: 0, finishedAt: 0 });
    clearTimeout(record.startTimer);
    record.startTimer = setTimeout(() => {
      if (record.item || entry.state !== 'progressing') return;
      this.expected.delete(entry.url);
      entry.state = 'interrupted';
      entry.finishedAt = this.now();
      this.changed();
      this.pump();
    }, START_TIMEOUT_MS);
    record.startTimer.unref?.();
    this.startDownload(entry.url);
    return true;
  }

  // ---------- Links added in bulk ----------
  // `links`: [{ url, filename, total }]; `start`: 'queue' (waits its turn, and for the night if
  // that is set), 'now' (starts at once, whatever the limit) or 'at' (waits for `startAt`).
  // `checksum` only with a single link. Returns the new entries' ids.
  addLinks({ links, saveDir, start = 'queue', startAt = 0, checksum = '' }) {
    if (!Array.isArray(links) || !saveDir || !path.isAbsolute(saveDir)) return [];
    const hex = links.length === 1 ? parseChecksum(checksum) : '';
    const ids = [];
    const seen = new Set();
    for (const link of links.slice(0, MAX_ADD)) {
      if (!isAllowedUrl(link?.url) || seen.has(link.url)) continue;
      seen.add(link.url);
      const entry = {
        id: this.nextId++,
        filename: text(link.filename, 260) || 'download',
        path: '',
        url: link.url,
        urlChain: [link.url],
        mimeType: '',
        etag: '',
        lastModified: '',
        startTime: 0,
        state: 'queued',
        received: 0,
        total: count(link.total),
        speed: 0,
        startedAt: this.now(),
        finishedAt: 0,
        kind: 'file',
        openWhenDone: false,
        kept: false,
        parts: null,
        saveDir,
        startAt: start === 'at' ? count(startAt) : 0,
        deferred: start !== 'now',
        order: this.nextOrder++,
        checksum: hex ? { expected: hex, result: '' } : null,
        isPrivate: false,
        restored: false,
      };
      const record = { entry, item: null, started: false, wasRunning: false, missingAt: 0, session: null, checkedSplit: false, throttled: false };
      this.records.set(entry.id, record);
      ids.push(entry.id);
      if (start === 'now') this.startWaiting(record);
    }
    this.startedThisRun = this.startedThisRun || ids.length > 0;
    this.trim();
    this.changed();
    this.pump();
    return ids;
  }

  // Moves a waiting download before another (or to the end, with no other).
  move(id, beforeId = null) {
    const queue = this.queue().map(({ entry }) => entry);
    const moving = queue.find((entry) => entry.id === id);
    if (!moving || (beforeId !== null && !queue.some((entry) => entry.id === beforeId))) return false;
    const rest = queue.filter((entry) => entry.id !== id);
    const at = beforeId === null ? rest.length : rest.findIndex((entry) => entry.id === beforeId);
    rest.splice(at, 0, moving);
    const base = Math.min(...queue.map((entry) => entry.order));
    rest.forEach((entry, index) => { entry.order = base + index; });
    this.nextOrder = Math.max(this.nextOrder, base + rest.length);
    this.changed();
    return true;
  }

  // ---------- Checksums ----------
  // Sets the SHA-256 a download should have; a finished one is checked at once.
  setChecksum(id, value) {
    const record = this.records.get(id);
    const hex = parseChecksum(value);
    if (!record || !hex) return false;
    record.entry.checksum = { expected: hex, result: '' };
    this.changed();
    if (record.entry.state === 'completed') this.verify(record);
    return true;
  }

  async verify(record) {
    const { entry } = record;
    if (!entry.checksum || !entry.path) return;
    entry.checksum = { ...entry.checksum, result: 'checking' };
    this.changed();
    let result;
    try {
      result = (await hashFile(entry.path)) === entry.checksum.expected ? 'match' : 'mismatch';
    } catch {
      result = 'error';
    }
    if (!entry.checksum) return;
    entry.checksum = { ...entry.checksum, result };
    this.changed();
    this.emit('checksum', { ...entry });
  }

  // True when nothing is downloading or waiting to (paused and failed downloads don't count).
  get idle() {
    return ![...this.records.values()].some(({ entry }) => entry.state === 'progressing' || entry.state === 'queued');
  }

  // ---------- What the pages can do ----------
  pause(id) {
    const record = this.records.get(id);
    if (!record?.item || !['progressing', 'queued'].includes(record.entry.state)) return false;
    record.throttled = false;
    record.item.pause();
    record.entry.state = 'paused';
    record.entry.speed = 0;
    this.changed();
    this.pump();
    return true;
  }

  // Resume (or Start now) runs it at once, whatever the limit or the schedule: the user asked.
  resume(id) {
    const record = this.records.get(id);
    if (!record || !['paused', 'queued'].includes(record.entry.state)) return false;
    if (!record.item && record.entry.state === 'queued' && record.entry.received === 0) return this.startWaiting(record);
    if (!record.item) return this.restore(record);
    record.started = true;
    record.item.resume();
    record.entry.state = 'progressing';
    this.changed();
    return true;
  }

  pauseAll() {
    let paused = 0;
    for (const { entry } of [...this.records.values()]) if (['progressing', 'queued'].includes(entry.state) && this.pause(entry.id)) paused += 1;
    return paused;
  }

  resumeAll() {
    let resumed = 0;
    for (const { entry } of [...this.records.values()]) if (entry.state === 'paused' && this.resume(entry.id)) resumed += 1;
    return resumed;
  }

  cancel(id) {
    const record = this.records.get(id);
    if (!record || !UNFINISHED.has(record.entry.state)) return false;
    clearTimeout(record.startTimer);
    if (record.item) {
      record.item.cancel();
      return true;
    }
    // A saved download that was never resumed: its partial file goes too.
    removeQuietly(partialFileOf(record.entry));
    record.entry.state = 'cancelled';
    record.entry.finishedAt = this.now();
    this.changed();
    return true;
  }

  // A failed download resumes if it can; otherwise (and for Download again) it starts over in
  // the same file. Private downloads can only resume: their session may be gone.
  retry(id) {
    const record = this.records.get(id);
    if (!record) return false;
    const { entry } = record;
    if (entry.state === 'interrupted' && record.item?.canResume?.()) {
      record.item.resume();
      entry.state = 'progressing';
      record.started = true;
      this.changed();
      return true;
    }
    if (!['interrupted', 'cancelled', 'completed'].includes(entry.state)) return false;
    if (entry.state === 'interrupted' && !record.item && this.canRestore(entry)) return this.restore(record);
    return this.startOver(record);
  }

  startOver(record) {
    const { entry } = record;
    if (entry.isPrivate || !this.startDownload) return false;
    record.item = null;
    if (entry.parts) removeQuietly(partialFileOf(entry));
    this.expect(entry.url, { entryId: entry.id, savePath: entry.path, kind: entry.kind });
    Object.assign(entry, { state: 'progressing', received: 0, speed: 0, finishedAt: 0, parts: null });
    if (entry.checksum) entry.checksum = { ...entry.checksum, result: '' };
    this.changed();
    this.startDownload(entry.url);
    return true;
  }

  canRestore(entry) {
    if (!entry.path || entry.received === 0 || !(entry.etag || entry.lastModified)) return false;
    if (entry.parts) return Boolean(this.segmented && fileSize(partialFileOf(entry)) === entry.total);
    return Boolean(this.createInterrupted && fileSize(entry.path) > 0);
  }

  // A saved download goes on from the bytes already in its file (Chromium asks the server for
  // the rest, and starts over if the file changed there).
  restore(record) {
    const { entry } = record;
    if (!this.canRestore(entry)) return this.startOver(record);
    if (entry.parts) return this.restoreSplit(record);
    const offset = Math.min(entry.received, fileSize(entry.path));
    try {
      // The file can hold a few bytes more than were counted when the list was saved.
      if (fileSize(entry.path) > offset) fs.truncateSync(entry.path, offset);
    } catch {
      return this.startOver(record);
    }
    entry.received = offset;
    entry.state = 'progressing';
    this.restoring.set(entry.path, entry.id);
    this.changed();
    this.createInterrupted({
      path: entry.path,
      urlChain: entry.urlChain.length ? entry.urlChain : [entry.url],
      mimeType: entry.mimeType || undefined,
      offset,
      length: entry.total,
      lastModified: entry.lastModified || undefined,
      eTag: entry.etag || undefined,
      startTime: entry.startTime || undefined,
    });
    return true;
  }

  // A download that was split over connections goes on from its parts' positions, with the
  // connections set now, in the regular profile (private downloads are never saved).
  restoreSplit(record) {
    const { entry } = record;
    let item;
    try {
      item = this.segmented.create({
        session: null,
        isPrivate: false,
        url: entry.urlChain.at(-1) || entry.url,
        urlChain: entry.urlChain,
        filename: entry.filename,
        savePath: entry.path,
        total: entry.total,
        etag: entry.etag,
        lastModified: entry.lastModified,
        mimeType: entry.mimeType,
        startTime: entry.startTime,
        connections: Math.max(1, this.segmented.connections()),
        limiter: this.limiter,
        parts: entry.parts,
      });
    } catch {
      return this.startOver(record);
    }
    record.item = item;
    record.started = true;
    record.checkedSplit = true;
    entry.state = 'progressing';
    this.wire(record, item);
    item.resume();
    this.changed();
    return true;
  }

  setOpenWhenDone(id, open) {
    const record = this.records.get(id);
    if (!record) return false;
    record.entry.openWhenDone = open;
    this.changed();
    return true;
  }

  // Takes a finished download off the list (its file stays).
  // A failed one Chromium could still resume is cancelled, which deletes its partial file.
  remove(id) {
    const record = this.records.get(id);
    if (!record || UNFINISHED.has(record.entry.state)) return false;
    const { item } = record;
    record.item = null;
    this.records.delete(id);
    if (item) item.cancel();
    else if (record.entry.state === 'interrupted') removeQuietly(partialFileOf(record.entry));
    this.changed();
    return true;
  }

  // Finished downloads started since a time (0: all of them), for clearing browsing data over a
  // time range. Only the list: the files stay. Running and waiting downloads are kept.
  countFinishedSince(since) {
    return [...this.records.values()].filter(({ entry }) => !UNFINISHED.has(entry.state) && entry.startedAt >= since).length;
  }

  removeFinishedSince(since) {
    let removed = 0;
    for (const [id, record] of [...this.records]) {
      const { entry, item } = record;
      if (UNFINISHED.has(entry.state) || entry.startedAt < since) continue;
      record.item = null;
      this.records.delete(id);
      // A failed download Chromium could still resume is cancelled, which deletes its partial file.
      if (item) item.cancel();
      removed += 1;
    }
    if (removed) this.changed();
    return removed;
  }

  // Completed, cancelled and blocked downloads; failed ones stay, to be retried.
  clearFinished() {
    let removed = 0;
    for (const [id, { entry }] of [...this.records]) {
      if (!FINISHED.has(entry.state)) continue;
      this.records.delete(id);
      removed += 1;
    }
    if (removed) this.changed();
    return removed;
  }

  trim() {
    for (const [id, { entry }] of this.records) {
      if (this.records.size <= MAX_TRACKED) break;
      if (!UNFINISHED.has(entry.state) && entry.state !== 'interrupted') this.records.delete(id);
    }
  }

  // ---------- What the pages are shown ----------
  isMissing(record) {
    if (record.entry.state !== 'completed' || !record.entry.path) return false;
    const now = this.now();
    if (now - record.missingAt > MISSING_CHECK_MS) {
      record.missingAt = now;
      record.missing = !fs.existsSync(record.entry.path);
    }
    return record.missing === true;
  }

  // Newest first, for the Downloads page.
  list() {
    return [...this.records.values()].reverse().map((record) => {
      const { urlChain: _chain, mimeType: _mime, etag: _etag, lastModified: _lm, startTime: _start, kept: _kept, parts, ...entry } = record.entry;
      const canResume = record.item ? (record.item.canResume?.() ?? false) : this.canRestore(record.entry);
      return {
        ...entry,
        connections: entry.connections ?? 0,
        // For the page's bar, while a split download runs: [start, end, position] per part.
        parts: parts && UNFINISHED.has(entry.state) ? parts : null,
        missing: this.isMissing(record),
        // What Retry does: picks up where it stopped, starts over, or (private, gone) nothing.
        retry: entry.state === 'interrupted' && canResume ? 'resume' : !entry.isPrivate && this.startDownload ? 'restart' : null,
      };
    });
  }

  // For the toolbar's button and panel: no addresses or folders.
  brief(limit = 5) {
    const items = this.list();
    const running = items.filter((entry) => UNFINISHED.has(entry.state));
    const known = running.filter((entry) => entry.total > 0);
    const total = known.reduce((sum, entry) => sum + entry.total, 0);
    return {
      visible: this.startedThisRun || running.length > 0,
      active: running.filter((entry) => entry.state === 'progressing').length,
      waiting: running.length,
      failed: items.filter((entry) => entry.state === 'interrupted').length,
      percent: total > 0 ? Math.min(100, Math.round(known.reduce((sum, entry) => sum + entry.received, 0) / total * 100)) : null,
      speed: running.reduce((sum, entry) => sum + entry.speed, 0),
      items: items.slice(0, limit).map(({ id, filename, state, received, total: size, speed, kind, missing }) => ({ id, filename, state, received, total: size, speed, kind, missing })),
    };
  }

  entry(id) {
    const record = this.records.get(id);
    return record ? { ...record.entry, missing: this.isMissing(record) } : null;
  }

  pathOf(id) {
    return this.records.get(id)?.entry.path || '';
  }
}

function chainOf(item) {
  const chain = item.getURLChain?.() ?? [];
  return chain.length ? [...chain] : [item.getURL?.() ?? ''].filter(Boolean);
}

function firstUrl(item) {
  return chainOf(item)[0] ?? '';
}

function fileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function removeQuietly(filePath) {
  if (!filePath) return;
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // The file stays; nothing else depends on it.
  }
}

module.exports = { DownloadManager, sanitizeEntry, parseChecksum, hashFile, uniquePath, MAX_TRACKED, MAX_ADD };
