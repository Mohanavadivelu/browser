'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ALLOWED_EXTENSIONS = new Map([['.webm', 'video'], ['.png', 'image']]);
const MAX_NAME_LENGTH = 150;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

// A recording file name is safe only if it is a plain file name inside the recordings folder.
function isSafeName(folder, name) {
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_NAME_LENGTH) return false;
  if (name !== path.basename(name) || name.startsWith('.') || /[\\/:*?"<>|\u0000-\u001f]/.test(name)) return false;
  if (!ALLOWED_EXTENSIONS.has(path.extname(name).toLowerCase())) return false;
  return path.dirname(path.resolve(folder, name)) === path.resolve(folder);
}

function sanitizeBaseName(text) {
  const cleaned = String(text ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 100);
  return cleaned && !RESERVED.test(cleaned) && !cleaned.startsWith('.') ? cleaned : null;
}

// Remembers recording lengths, because the video files themselves do not store a duration.
class RecordingIndex {
  constructor(filePath) {
    this.filePath = filePath;
    this.durations = {};
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      this.durations = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    } catch {
      this.durations = {};
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.durations));
    } catch (error) {
      console.error(`Could not save the recordings index: ${error.message}`);
    }
  }

  set(name, durationMs) {
    this.durations[name] = Math.max(0, Math.round(durationMs));
    this.save();
  }

  get(name) {
    return this.durations[name] ?? null;
  }

  rename(from, to) {
    if (!(from in this.durations)) return;
    this.durations[to] = this.durations[from];
    delete this.durations[from];
    this.save();
  }

  remove(name) {
    if (!(name in this.durations)) return;
    delete this.durations[name];
    this.save();
  }
}

function listRecordings(folder, index) {
  let names;
  try {
    names = fs.readdirSync(folder);
  } catch {
    return [];
  }
  const entries = [];
  for (const name of names) {
    if (!isSafeName(folder, name)) continue;
    try {
      const stats = fs.statSync(path.join(folder, name));
      if (!stats.isFile()) continue;
      entries.push({
        name,
        type: ALLOWED_EXTENSIONS.get(path.extname(name).toLowerCase()),
        size: stats.size,
        modified: stats.mtimeMs,
        durationMs: index?.get(name) ?? null,
      });
    } catch {
      // The file disappeared while listing; skip it.
    }
  }
  return entries.sort((a, b) => b.modified - a.modified);
}

function renameRecording(folder, name, newBase, index) {
  if (!isSafeName(folder, name)) return { ok: false, reason: 'invalid-name' };
  const base = sanitizeBaseName(newBase);
  if (!base) return { ok: false, reason: 'invalid-name' };
  const newName = base + path.extname(name).toLowerCase();
  if (!isSafeName(folder, newName)) return { ok: false, reason: 'invalid-name' };
  if (newName === name) return { ok: true, name };
  const target = path.join(folder, newName);
  if (fs.existsSync(target)) return { ok: false, reason: 'exists' };
  try {
    fs.renameSync(path.join(folder, name), target);
  } catch (error) {
    return { ok: false, reason: 'failed', message: error.message };
  }
  index?.rename(name, newName);
  return { ok: true, name: newName };
}

// `trash` moves the file to the Recycle Bin so a delete can be undone.
async function deleteRecording(folder, name, trash, index) {
  if (!isSafeName(folder, name)) return { ok: false, reason: 'invalid-name' };
  const target = path.join(folder, name);
  if (!fs.existsSync(target)) return { ok: false, reason: 'missing' };
  try {
    await trash(target);
  } catch (error) {
    return { ok: false, reason: 'failed', message: error.message };
  }
  index?.remove(name);
  return { ok: true };
}

module.exports = {
  isSafeName, sanitizeBaseName, RecordingIndex, listRecordings, renameRecording, deleteRecording,
};
