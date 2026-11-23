'use strict';

const fs = require('node:fs');
const { openRecordingFile } = require('./storage');

const AUTHORIZATION_WINDOW_MS = 15000;

// Elapsed recording time that excludes paused periods; `now` is injectable for tests.
class RecordingClock {
  constructor(now = Date.now) {
    this.now = now;
    this.reset();
  }

  reset() {
    this.base = 0;
    this.since = null;
  }

  start() {
    this.base = 0;
    this.since = this.now();
  }

  pause() {
    if (this.since === null) return;
    this.base += this.now() - this.since;
    this.since = null;
  }

  resume() {
    if (this.since === null) this.since = this.now();
  }

  elapsed() {
    return this.base + (this.since === null ? 0 : this.now() - this.since);
  }

  get paused() {
    return this.since === null;
  }
}

// Recording can only begin after the consent dialog; the grant is single-use and short-lived.
// A recording is one or more files ("parts") when it follows the user to another tab.
class Recorder {
  constructor({ getFolder, requestConsent, onChange, notify, onSegment = () => {}, now = Date.now }) {
    this.getFolder = getFolder;
    this.requestConsent = requestConsent;
    this.onChange = onChange;
    this.notify = notify;
    this.onSegment = onSegment;
    this.now = now;
    this.clock = new RecordingClock(now);
    this.authorizedUntil = 0;
    this.file = null;
    this.session = null;
    this.segmentStartMs = 0;
  }

  get active() {
    return this.file !== null;
  }

  get paused() {
    return this.active && this.clock.paused;
  }

  // The interface shows the timer as baseMs plus the time since runningSince (null while paused).
  get info() {
    return {
      active: this.active,
      paused: this.paused,
      baseMs: this.active ? this.clock.base : 0,
      runningSince: this.active ? this.clock.since : null,
    };
  }

  async requestStart() {
    if (this.active) return { ok: false, reason: 'already-recording' };
    const consent = await this.requestConsent();
    if (!consent.granted) {
      if (consent.reason === 'unchecked') {
        this.notify('Recording needs the permission box ticked.', 'warning');
      }
      return { ok: false, reason: 'declined' };
    }
    const date = new Date();
    try {
      this.file = openRecordingFile(this.getFolder(), date, 1);
    } catch (error) {
      this.notify(`Could not create the recording file: ${error.message}`, 'error');
      return { ok: false, reason: 'file-error' };
    }
    this.watch(this.file);
    this.session = { date, part: 1 };
    this.clock.start();
    this.segmentStartMs = 0;
    this.authorizedUntil = this.now() + AUTHORIZATION_WINDOW_MS;
    this.onChange();
    return { ok: true };
  }

  watch(file) {
    file.stream.on('error', (error) => {
      this.notify(`Recording write failed: ${error.message}`, 'error');
    });
  }

  // Called by the capture handler; each consent allows exactly one capture.
  consumeAuthorization() {
    const allowed = this.active && this.now() <= this.authorizedUntil;
    this.authorizedUntil = 0;
    return allowed;
  }

  // Lets a capture be retried while a recording the user already agreed to is running.
  authorizeCapture() {
    if (!this.active) return false;
    this.authorizedUntil = this.now() + AUTHORIZATION_WINDOW_MS;
    return true;
  }

  write(chunk) {
    if (!this.active) return false;
    const buffer = chunk instanceof ArrayBuffer
      ? Buffer.from(chunk)
      : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    this.file.stream.write(buffer);
    return true;
  }

  setPaused(paused) {
    if (!this.active) return false;
    if (paused) this.clock.pause();
    else this.clock.resume();
    this.onChange();
    return true;
  }

  // Closes the current part and starts the next one, keeping the recording going.
  async rollover() {
    if (!this.active) return { ok: false, reason: 'not-recording' };
    const previous = this.file;
    const durationMs = this.clock.elapsed() - this.segmentStartMs;
    let next;
    try {
      next = openRecordingFile(this.getFolder(), this.session.date, this.session.part + 1);
    } catch (error) {
      this.notify(`Could not create the next recording file: ${error.message}`, 'error');
      await this.finish();
      return { ok: false, reason: 'file-error' };
    }
    this.watch(next);
    this.file = next;
    this.session.part += 1;
    this.segmentStartMs = this.clock.elapsed();
    this.authorizedUntil = this.now() + AUTHORIZATION_WINDOW_MS;
    await new Promise((resolve) => previous.stream.end(resolve));
    this.onSegment(previous.filePath, durationMs, false);
    this.onChange();
    return { ok: true };
  }

  async finish() {
    if (!this.active) return null;
    const { filePath, stream } = this.file;
    const durationMs = this.clock.elapsed() - this.segmentStartMs;
    this.file = null;
    this.session = null;
    this.authorizedUntil = 0;
    this.clock.reset();
    await new Promise((resolve) => stream.end(resolve));
    this.onSegment(filePath, durationMs, true);
    this.onChange();
    return filePath;
  }

  // Used when capture could not start: keep nothing behind if no data was written.
  async abort() {
    if (!this.active) return;
    const { filePath, stream } = this.file;
    this.file = null;
    this.session = null;
    this.authorizedUntil = 0;
    this.clock.reset();
    await new Promise((resolve) => stream.end(resolve));
    this.removeIfEmpty(filePath);
    this.onChange();
  }

  // Returns true when the file had no data and was deleted.
  removeIfEmpty(filePath) {
    try {
      if (fs.statSync(filePath).size > 0) return false;
      fs.unlinkSync(filePath);
      return true;
    } catch {
      return false;
    }
  }
}

module.exports = { Recorder, RecordingClock };
