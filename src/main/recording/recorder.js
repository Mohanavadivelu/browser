'use strict';

const fs = require('node:fs');
const { openRecordingFile } = require('./storage');

const AUTHORIZATION_WINDOW_MS = 15000;

// Recording can only begin after the consent dialog; the grant is single-use and short-lived.
class Recorder {
  constructor({ getFolder, requestConsent, onChange, notify }) {
    this.getFolder = getFolder;
    this.requestConsent = requestConsent;
    this.onChange = onChange;
    this.notify = notify;
    this.authorizedUntil = 0;
    this.file = null;
    this.startedAt = null;
  }

  get active() {
    return this.file !== null;
  }

  get info() {
    return { active: this.active, startedAt: this.startedAt };
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
    try {
      this.file = openRecordingFile(this.getFolder());
    } catch (error) {
      this.notify(`Could not create the recording file: ${error.message}`, 'error');
      return { ok: false, reason: 'file-error' };
    }
    this.file.stream.on('error', (error) => {
      this.notify(`Recording write failed: ${error.message}`, 'error');
    });
    this.authorizedUntil = Date.now() + AUTHORIZATION_WINDOW_MS;
    this.startedAt = Date.now();
    this.onChange();
    return { ok: true };
  }

  // Called by the screen-capture handler; each consent allows exactly one capture.
  consumeAuthorization() {
    const allowed = this.active && Date.now() <= this.authorizedUntil;
    this.authorizedUntil = 0;
    return allowed;
  }

  write(chunk) {
    if (!this.active) return false;
    const buffer = chunk instanceof ArrayBuffer
      ? Buffer.from(chunk)
      : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    this.file.stream.write(buffer);
    return true;
  }

  async finish() {
    if (!this.active) return null;
    const { filePath, stream } = this.file;
    this.file = null;
    this.startedAt = null;
    this.authorizedUntil = 0;
    await new Promise((resolve) => stream.end(resolve));
    this.onChange();
    return filePath;
  }

  // Used when capture could not start: keep nothing behind if no data was written.
  async abort() {
    const filePath = await this.finish();
    if (!filePath) return;
    try {
      if (fs.statSync(filePath).size === 0) fs.unlinkSync(filePath);
    } catch {
      // File already gone; nothing to clean up.
    }
  }
}

module.exports = { Recorder };
