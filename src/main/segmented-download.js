'use strict';

const fs = require('node:fs');
const { EventEmitter } = require('node:events');

// Downloads one file over several connections at once, each asking the server for its own part
// (a Range request), into a temporary file next to the real one that is renamed when the last
// part is in. When a part finishes early it takes over half of the largest part still running,
// so every connection keeps busy until the end.
//
// It stands in for Electron's DownloadItem (the same methods and the 'updated' and 'done'
// events), so the download list treats both alike. The browser starts every download the
// normal way, and hands it over to this only after a probe shows the server answers Range
// requests for the same file (see probeRanges).
const PART_SUFFIX = '.sbpart';
const MIN_PART_BYTES = 1024 * 1024; // a part is never split below this
const MAX_PARTS = 32;
const MAX_ATTEMPTS = 5;
const UPDATE_EVERY_MS = 250;
const SPEED_WINDOW_MS = 2000;

class ServerChanged extends Error {}

// Whether a reply is a byte range of the same file: 206, no compression, the expected start,
// size and (when one is known) version tag.
function checkRange(response, { from, total, etag }) {
  if (response.status !== 206) return false;
  const encoding = (response.headers.get('content-encoding') ?? 'identity').toLowerCase();
  if (encoding !== 'identity') return false;
  const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
  if (!range || Number(range[1]) !== from || Number(range[3]) !== total) return false;
  const tag = response.headers.get('etag');
  return !etag || !tag || tag === etag;
}

// Asks for the first byte only. True when the server can serve this file in parts.
async function probeRanges(fetch, { url, total, etag }) {
  const controller = new AbortController();
  try {
    const response = await fetch(url, { headers: { Range: 'bytes=0-0' }, cache: 'no-store', signal: controller.signal });
    return checkRange(response, { from: 0, total, etag });
  } catch {
    return false;
  } finally {
    controller.abort();
  }
}

// How fast downloads may go together: tokens refill at the limit, a reader takes what it read
// and waits off any debt. `limit()` is in bytes a second; 0 means no limit.
class RateLimiter {
  constructor(limit = () => 0, now = Date.now) {
    this.limit = limit;
    this.now = now;
    this.tokens = 0;
    this.at = now();
  }

  refill() {
    const limit = this.limit();
    const now = this.now();
    if (!limit) {
      this.tokens = 0;
    } else {
      this.tokens = Math.min(limit / 4, this.tokens + ((now - this.at) / 1000) * limit);
    }
    this.at = now;
    return limit;
  }

  // Counts bytes that came in some other way (a download Chromium handles).
  consume(bytes) {
    if (this.refill()) this.tokens -= bytes;
  }

  get overBudget() {
    return this.refill() > 0 && this.tokens < 0;
  }

  async take(bytes) {
    const limit = this.refill();
    if (!limit) return;
    this.tokens -= bytes;
    if (this.tokens < 0) await new Promise((resolve) => setTimeout(resolve, Math.min(5000, (-this.tokens / limit) * 1000)));
  }
}

class SegmentedDownload extends EventEmitter {
  // `fetch(url, init)` is the session's fetch (its cookies and network rules). `parts`, from a
  // saved list, are [start, end, position] triples.
  constructor({ fetch, url, urlChain = [url], filename, savePath, total, etag = '', lastModified = '', mimeType = '', startTime = 0,
    connections = 8, limiter = new RateLimiter(), parts = null, now = Date.now }) {
    super();
    Object.assign(this, { fetch, url, urlChain, filename, savePath, total, etag, lastModified, mimeType, startTime, connections, limiter, now });
    this.isSegmented = true;
    this.state = 'progressing';
    this.paused = true; // until start() or resume()
    this.resumable = true;
    this.parts = parts?.length ? parts.map(([start, end, pos]) => ({ start, end, pos, controller: null, active: false })) : this.split();
    this.handle = null;
    this.run = 0; // each start or resume is a new run; workers of an older one stop
    this.samples = [];
    this.lastUpdate = 0;
    this.finishing = false;
    this.closing = Promise.resolve();
  }

  get tempPath() {
    return `${this.savePath}${PART_SUFFIX}`;
  }

  split() {
    const count = Math.max(1, Math.min(this.connections, Math.floor(this.total / MIN_PART_BYTES)));
    const size = Math.ceil(this.total / count);
    const parts = [];
    for (let start = 0; start < this.total; start += size) {
      parts.push({ start, end: Math.min(this.total, start + size) - 1, pos: start, controller: null, active: false });
    }
    return parts;
  }

  // ---------- What a DownloadItem offers ----------
  getFilename() { return this.filename; }
  getURL() { return this.url; }
  getURLChain() { return [...this.urlChain]; }
  getMimeType() { return this.mimeType; }
  getETag() { return this.etag; }
  getLastModifiedTime() { return this.lastModified; }
  getStartTime() { return this.startTime; }
  getTotalBytes() { return this.total; }
  getSavePath() { return this.savePath; }
  getState() { return this.state; }
  isPaused() { return this.paused && this.state === 'progressing'; }
  canResume() { return this.resumable && (this.state === 'progressing' || this.state === 'interrupted'); }
  getReceivedBytes() { return this.parts.reduce((sum, part) => sum + (Math.min(part.pos, part.end + 1) - part.start), 0); }
  getParts() { return this.parts.map((part) => [part.start, part.end, part.pos]); }
  getActiveConnections() { return this.parts.filter((part) => part.active).length; }

  getCurrentBytesPerSecond() {
    if (this.paused) return 0;
    const since = this.now() - SPEED_WINDOW_MS;
    this.samples = this.samples.filter(([time]) => time >= since);
    return this.samples.reduce((sum, [, bytes]) => sum + bytes, 0) / (SPEED_WINDOW_MS / 1000);
  }

  // ---------- Control ----------
  start() {
    return this.resume();
  }

  resume() {
    if (this.state === 'interrupted' && this.resumable) this.state = 'progressing';
    if (this.state !== 'progressing' || !this.paused) return;
    this.paused = false;
    const run = ++this.run;
    this.open()
      .then(() => { if (run === this.run) this.fill(run); })
      .catch((error) => this.fail(error, run));
    this.update(true);
  }

  pause() {
    if (this.state !== 'progressing' || this.paused) return;
    this.paused = true;
    this.stopWorkers();
    this.update(true);
  }

  cancel() {
    if (this.state === 'completed' || this.state === 'cancelled') return;
    this.stopWorkers();
    this.state = 'cancelled';
    // Windows can't delete a file that is still open.
    this.closing.finally(() => {
      fs.rm(this.tempPath, { force: true }, () => this.emit('done', {}, 'cancelled'));
    });
  }

  stopWorkers() {
    this.run += 1;
    for (const part of this.parts) {
      part.controller?.abort();
      part.controller = null;
      part.active = false;
    }
    this.closing = this.closeFile();
  }

  // ---------- The file ----------
  async open() {
    if (this.handle) return;
    let exists = false;
    try {
      exists = fs.statSync(this.tempPath).size === this.total;
    } catch {
      exists = false;
    }
    // Parts saved without their file start over.
    if (!exists) for (const part of this.parts) part.pos = part.start;
    this.handle = await fs.promises.open(this.tempPath, exists ? 'r+' : 'w+');
    if (!exists) await this.handle.truncate(this.total);
  }

  async closeFile() {
    const { handle } = this;
    this.handle = null;
    if (handle) await handle.close().catch(() => {});
  }

  // ---------- The connections ----------
  // Starts a connection for each part still to fetch, up to the limit, and splits the largest
  // running part when a connection is free and nothing else is waiting.
  fill(run) {
    if (run !== this.run || this.paused || this.state !== 'progressing') return;
    const remaining = this.parts.filter((part) => part.pos <= part.end);
    if (remaining.length === 0) {
      this.finish(run);
      return;
    }
    let active = this.parts.filter((part) => part.active).length;
    for (const part of remaining) {
      if (active >= this.connections) break;
      if (part.active) continue;
      active += 1;
      this.work(part, run);
    }
    while (active < this.connections && this.parts.length < MAX_PARTS) {
      const largest = this.parts.filter((part) => part.active).sort((a, b) => (b.end - b.pos) - (a.end - a.pos))[0];
      if (!largest || largest.end - largest.pos < 2 * MIN_PART_BYTES) break;
      const middle = largest.pos + Math.floor((largest.end - largest.pos) / 2);
      const taken = { start: middle + 1, end: largest.end, pos: middle + 1, controller: null, active: false };
      largest.end = middle;
      this.parts.push(taken);
      active += 1;
      this.work(taken, run);
    }
  }

  async work(part, run) {
    part.active = true;
    for (let attempt = 1; ; attempt += 1) {
      if (run !== this.run) return;
      try {
        await this.fetchPart(part, run);
        break;
      } catch (error) {
        if (run !== this.run) return;
        if (error instanceof ServerChanged || attempt >= MAX_ATTEMPTS) {
          part.active = false;
          this.fail(error, run);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      }
    }
    part.active = false;
    part.controller = null;
    this.fill(run);
  }

  async fetchPart(part, run) {
    if (part.pos > part.end) return;
    const controller = new AbortController();
    part.controller = controller;
    const headers = { Range: `bytes=${part.pos}-${part.end}` };
    // The rest of the file only if it hasn't changed since the first part; otherwise the server
    // sends the whole file (200), and the download starts over.
    if (this.etag || this.lastModified) headers['If-Range'] = this.etag || this.lastModified;
    const response = await this.fetch(this.url, { headers, cache: 'no-store', signal: controller.signal });
    if (run !== this.run) return;
    if (!checkRange(response, { from: part.pos, total: this.total, etag: this.etag })) {
      controller.abort();
      throw new ServerChanged(`The server sent ${response.status} instead of the part asked for`);
    }
    const reader = response.body.getReader();
    try {
      while (part.pos <= part.end) {
        const { done, value } = await reader.read();
        if (run !== this.run) return;
        if (done) {
          if (part.pos <= part.end) throw new Error('The connection closed early');
          break;
        }
        // A part split meanwhile ends sooner: what is past its new end belongs to another.
        const bytes = Math.min(value.length, part.end - part.pos + 1);
        if (bytes <= 0) break;
        await this.limiter.take(bytes);
        if (run !== this.run || !this.handle) return;
        await this.handle.write(value, 0, bytes, part.pos);
        part.pos += bytes;
        this.samples.push([this.now(), bytes]);
        this.update();
      }
    } finally {
      controller.abort();
    }
  }

  async finish(run) {
    if (this.finishing || run !== this.run) return;
    this.finishing = true;
    try {
      await this.closeFile();
      fs.rmSync(this.savePath, { force: true });
      fs.renameSync(this.tempPath, this.savePath);
      this.state = 'completed';
      this.paused = true;
      this.emit('done', {}, 'completed');
    } catch (error) {
      this.finishing = false;
      this.fail(error, run);
    }
  }

  // A failed download keeps its parts to resume later ('updated', as Electron reports a
  // download it can resume), unless the file changed on the server: then it can only start
  // over, its parts are thrown away and it is done ('done', interrupted).
  fail(error, run) {
    if (run !== this.run || this.state !== 'progressing') return;
    this.stopWorkers();
    this.paused = true;
    this.state = 'interrupted';
    this.error = error.message;
    if (error instanceof ServerChanged) {
      this.resumable = false;
      this.closing.finally(() => fs.rm(this.tempPath, { force: true }, () => this.emit('done', {}, 'interrupted')));
      return;
    }
    this.emit('updated', {}, 'interrupted');
  }

  update(now = false) {
    const time = this.now();
    if (!now && time - this.lastUpdate < UPDATE_EVERY_MS) return;
    this.lastUpdate = time;
    this.emit('updated', {}, 'progressing');
  }
}

module.exports = { SegmentedDownload, RateLimiter, probeRanges, checkRange, PART_SUFFIX, MIN_PART_BYTES };
