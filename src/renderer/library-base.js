'use strict';

// The library pages (History, Bookmarks, Downloads, Recordings, Settings) are one page whose
// scripts share one scope. This one is loaded first: the bridge, the page list and small helpers
// the others use. library.js, loaded last, wires the pages together (see library.html).
const api = window.browserApi;
const PAGES = ['history', 'bookmarks', 'downloads', 'recordings', 'settings'];
const TITLES = { history: 'History', bookmarks: 'Bookmarks', downloads: 'Downloads', recordings: 'Recordings', settings: 'Settings' };
const $ = (id) => document.getElementById(id);

let current = 'history';
let searchTimer;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label, onClick, className) {
  const node = element('button', className, label);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function formatDuration(ms) {
  const total = Math.round(ms / 1000);
  const pad = (value) => String(value).padStart(2, '0');
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return hours ? `${hours}:${pad(minutes)}:${pad(total % 60)}` : `${minutes}:${pad(total % 60)}`;
}

const formatDate = (time) => new Date(time).toLocaleString();
