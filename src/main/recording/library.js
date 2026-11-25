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
// Also remembers the markers set while recording (milliseconds from the start of each file).
// Saved as { durations: { name: ms }, markers: { name: [ms] } }; the older file, a plain map of
// durations, is still read.
const MAX_MARKERS = 500;

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function cleanMarkers(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((ms) => Number.isFinite(ms) && ms >= 0).map((ms) => Math.round(ms)).sort((a, b) => a - b).slice(0, MAX_MARKERS);
}

class RecordingIndex {
  constructor(filePath) {
    this.filePath = filePath;
    this.durations = {};
    this.markers = {};
  }

  load() {
    try {
      const raw = plainObject(JSON.parse(fs.readFileSync(this.filePath, 'utf8')));
      const current = 'durations' in raw && typeof raw.durations === 'object';
      this.durations = plainObject(current ? raw.durations : raw);
      this.markers = {};
      for (const [name, list] of Object.entries(current ? plainObject(raw.markers) : {})) {
        const markers = cleanMarkers(list);
        if (markers.length) this.markers[name] = markers;
      }
    } catch {
      this.durations = {};
      this.markers = {};
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify({ durations: this.durations, markers: this.markers }));
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

  setMarkers(name, list) {
    const markers = cleanMarkers(list);
    if (markers.length) this.markers[name] = markers;
    else delete this.markers[name];
    this.save();
  }

  markersOf(name) {
    return [...(this.markers[name] ?? [])];
  }

  rename(from, to) {
    if (!(from in this.durations) && !(from in this.markers)) return;
    for (const map of [this.durations, this.markers]) {
      if (from in map) {
        map[to] = map[from];
        delete map[from];
      }
    }
    this.save();
  }

  remove(name) {
    if (!(name in this.durations) && !(name in this.markers)) return;
    delete this.durations[name];
    delete this.markers[name];
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
        markers: index?.markersOf(name) ?? [],
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

// ---------- Trimming and joining (new files; the originals are never changed) ----------

const PART_NAME = /^(.+?)(?:-part(\d+))?\.webm$/i;
const MAX_EDIT_BASE = 100;

// A name for a new file: "<base>-<label>.webm", or "-<label>-2.webm" and so on if taken.
function freeName(folder, base, label) {
  const stem = base.slice(0, MAX_EDIT_BASE);
  for (let copy = 1; copy < 1000; copy += 1) {
    const name = `${stem}-${label}${copy > 1 ? `-${copy}` : ''}.webm`;
    if (isSafeName(folder, name) && !fs.existsSync(path.join(folder, name))) return name;
  }
  return null;
}

// The parts of the recording `name` belongs to, in order: "x.webm", "x-part2.webm", ...
function partsOf(folder, name) {
  const match = PART_NAME.exec(name);
  if (!match || !isSafeName(folder, name)) return [];
  const base = match[1];
  let names;
  try {
    names = fs.readdirSync(folder);
  } catch {
    return [];
  }
  return names
    .map((candidate) => ({ candidate, part: PART_NAME.exec(candidate) }))
    .filter(({ candidate, part }) => part && part[1] === base && isSafeName(folder, candidate))
    .map(({ candidate, part }) => ({ candidate, number: part[2] ? Number(part[2]) : 1 }))
    .sort((a, b) => a.number - b.number)
    .map(({ candidate }) => candidate);
}

// Saves the part of `name` between startMs and endMs as a new recording. The cut starts on the
// last keyframe at or before startMs. `write` is webm-edit's writeRecording.
async function trimRecording(folder, name, startMs, endMs, index, write) {
  if (!isSafeName(folder, name) || path.extname(name).toLowerCase() !== '.webm') return { ok: false, reason: 'invalid-name' };
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs <= startMs) return { ok: false, reason: 'invalid-range' };
  const newName = freeName(folder, path.basename(name, path.extname(name)), 'trimmed');
  if (!newName) return { ok: false, reason: 'failed', message: 'no free file name' };
  try {
    const result = await write(path.join(folder, newName), [{ path: path.join(folder, name), from: startMs, to: endMs, markers: index?.markersOf(name) }]);
    index?.set(newName, result.durationMs);
    index?.setMarkers(newName, result.markers);
    return { ok: true, name: newName, startMs: result.startMs, durationMs: result.durationMs };
  } catch (error) {
    return { ok: false, reason: 'failed', message: error.message };
  }
}

// Joins all parts of the recording `name` belongs to into one new recording.
async function joinRecording(folder, name, index, write) {
  const parts = partsOf(folder, name);
  if (parts.length < 2) return { ok: false, reason: 'no-parts' };
  const base = PART_NAME.exec(parts[0])[1];
  const newName = freeName(folder, base, 'joined');
  if (!newName) return { ok: false, reason: 'failed', message: 'no free file name' };
  try {
    const result = await write(path.join(folder, newName), parts.map((part) => ({ path: path.join(folder, part), markers: index?.markersOf(part) })));
    index?.set(newName, result.durationMs);
    index?.setMarkers(newName, result.markers);
    return { ok: true, name: newName, parts: parts.length, durationMs: result.durationMs };
  } catch (error) {
    return { ok: false, reason: 'failed', message: error.message };
  }
}

module.exports = {
  isSafeName, sanitizeBaseName, RecordingIndex, listRecordings, renameRecording, deleteRecording,
  freeName, partsOf, trimRecording, joinRecording,
};
