'use strict';

const fs = require('node:fs');
const path = require('node:path');

function pad(value) {
  return String(value).padStart(2, '0');
}

function recordingFileName(date = new Date()) {
  const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `recording-${day}-${time}.webm`;
}

// Recordings are written only to a local folder; nothing is ever uploaded.
function openRecordingFile(folder, date = new Date()) {
  fs.mkdirSync(folder, { recursive: true });
  const filePath = path.join(folder, recordingFileName(date));
  return { filePath, stream: fs.createWriteStream(filePath, { flags: 'wx' }) };
}

module.exports = { recordingFileName, openRecordingFile };
