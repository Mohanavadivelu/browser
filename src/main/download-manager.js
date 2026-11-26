'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { isAllowedUrl } = require('./security/navigation');

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
  };
}

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
// session.createInterruptedDownload in the regular profile (for resuming a saved download).
// Electron's DownloadItems are handed in with track(), from the session's will-download.
class DownloadManager extends EventEmitter {
  constructor({ storePath = null, maxActive = () => 3, startDownload = null, createInterrupted = null, now = Date.now } = {}) {
    super();
    this.storePath = storePath;
    this.maxActive = maxActive;
    this.startDownload = startDownload;
    this.createInterrupted = createInterrupted;
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
      const wasRunning = clean.state === 'progressing' || clean.state === 'queued';
      if (UNFINISHED.has(clean.state)) {
        clean.state = 'paused';
        unfinished += 1;
      }
      const entry = { id: this.nextId++, ...clean, speed: 0, isPrivate: false, restored: UNFINISHED.has(raw.state) };
      this.records.set(entry.id, { entry, item: null, started: false, wasRunning, missingAt: 0 });
    }
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
        const { id: _id, speed: _speed, isPrivate: _private, restored: _restored, ...saved } = entry;
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
      if (!item || !unfinished || entry.isPrivate || !entry.path || fileSize(entry.path) === 0) continue;
      entry.received = item.getReceivedBytes();
      entry.kept = keepPartial(entry.path);
    }
    this.save();
    this.closed = true;
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

  // Where a download should be saved without asking: a retry goes back into its own file.
  presetPath(item) {
    if (item.getSavePath()) return '';
    return this.expected.get(firstUrl(item))?.savePath ?? '';
  }

  track(item, { isPrivate = false } = {}) {
    const url = firstUrl(item);
    const expected = this.expected.get(url);
    if (expected) this.expected.delete(url);
    const restoringId = this.restoring.get(item.getSavePath());
    if (restoringId) this.restoring.delete(item.getSavePath());
    const adoptId = restoringId ?? expected?.entryId;
    let record = adoptId ? this.records.get(adoptId) : null;

    if (record) {
      record.item = item;
      record.started = true;
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
        isPrivate,
        restored: false,
      };
      record = { entry, item, started: false, wasRunning: false, missingAt: 0 };
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
        entry.state = 'interrupted';
      } else if (entry.state !== 'queued') {
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
      if (entry.state === 'completed') this.emit('completed', { ...entry });
      this.pump();
    });
  }

  copyDetails(entry, item) {
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

  // ---------- The queue ----------
  // Downloads running now. One still waiting for its file to be chosen doesn't count yet.
  activeCount(exceptId) {
    let active = 0;
    for (const { entry, started } of this.records.values()) if (started && entry.state === 'progressing' && entry.id !== exceptId) active += 1;
    return active;
  }

  // Starts waiting downloads, oldest first, while there is room.
  pump() {
    const waiting = [...this.records.values()].filter(({ entry, item }) => entry.state === 'queued' && item);
    for (const record of waiting) {
      if (this.activeCount() >= this.maxActive()) break;
      record.entry.state = 'progressing';
      record.item.resume();
    }
    if (waiting.length) this.changed();
  }

  // ---------- What the pages can do ----------
  pause(id) {
    const record = this.records.get(id);
    if (!record?.item || !['progressing', 'queued'].includes(record.entry.state)) return false;
    record.item.pause();
    record.entry.state = 'paused';
    record.entry.speed = 0;
    this.changed();
    this.pump();
    return true;
  }

  // Resume (or Start now) runs it at once, whatever the limit: the user asked for it.
  resume(id) {
    const record = this.records.get(id);
    if (!record || !['paused', 'queued'].includes(record.entry.state)) return false;
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
    if (record.item) {
      record.item.cancel();
      return true;
    }
    // A saved download that was never resumed: its partial file goes too.
    removeQuietly(record.entry.path);
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
    this.expect(entry.url, { entryId: entry.id, savePath: entry.path, kind: entry.kind });
    Object.assign(entry, { state: 'progressing', received: 0, speed: 0, finishedAt: 0 });
    this.changed();
    this.startDownload(entry.url);
    return true;
  }

  canRestore(entry) {
    return Boolean(this.createInterrupted && entry.path && entry.received > 0 && (entry.etag || entry.lastModified) && fileSize(entry.path) > 0);
  }

  // A saved download goes on from the bytes already in its file (Chromium asks the server for
  // the rest, and starts over if the file changed there).
  restore(record) {
    const { entry } = record;
    if (!this.canRestore(entry)) return this.startOver(record);
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
    else if (record.entry.state === 'interrupted') removeQuietly(record.entry.path);
    this.changed();
    return true;
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
      const { urlChain: _chain, mimeType: _mime, etag: _etag, lastModified: _lm, startTime: _start, kept: _kept, ...entry } = record.entry;
      const canResume = record.item ? (record.item.canResume?.() ?? false) : this.canRestore(record.entry);
      return {
        ...entry,
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

module.exports = { DownloadManager, sanitizeEntry, MAX_TRACKED };
