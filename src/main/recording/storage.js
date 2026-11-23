'use strict';

const fs = require('node:fs');
const path = require('node:path');

function pad(value) {
  return String(value).padStart(2, '0');
}

function stamp(date) {
  const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `${day}-${time}`;
}

// Part 1 has the plain name; later parts (recording followed another tab) get a -partN suffix.
function recordingFileName(date = new Date(), part = 1) {
  return `recording-${stamp(date)}${part > 1 ? `-part${part}` : ''}.webm`;
}

function screenshotFileName(date = new Date(), copy = 1) {
  return `screenshot-${stamp(date)}${copy > 1 ? `-${copy}` : ''}.png`;
}

// Recordings are written only to a local folder; nothing is ever uploaded.
function openRecordingFile(folder, date = new Date(), part = 1) {
  fs.mkdirSync(folder, { recursive: true });
  const filePath = path.join(folder, recordingFileName(date, part));
  return { filePath, stream: fs.createWriteStream(filePath, { flags: 'wx' }) };
}

// Never overwrites: two screenshots in the same second get a numbered name.
function saveScreenshot(folder, png, date = new Date()) {
  fs.mkdirSync(folder, { recursive: true });
  for (let copy = 1; copy < 1000; copy++) {
    const filePath = path.join(folder, screenshotFileName(date, copy));
    try {
      fs.writeFileSync(filePath, png, { flag: 'wx' });
      return filePath;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  throw new Error('Too many screenshots with the same name');
}

module.exports = { recordingFileName, screenshotFileName, openRecordingFile, saveScreenshot };
