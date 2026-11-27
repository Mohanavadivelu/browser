'use strict';

// ---------- Downloads page ----------
// Loaded before library.js and called from it (it uses that file's helpers when it runs).
// Downloads are grouped (Downloading, Waiting, Failed, Done) and can be filtered and searched.
// Progress arrives several times a second, so rows are built once and then updated in place:
// a button is only replaced when what it does changes, and a click on it is never lost.
const DOWNLOAD_GROUPS = [
  { key: 'active', title: 'Downloading', states: ['progressing', 'paused'] },
  { key: 'waiting', title: 'Waiting', states: ['queued'] },
  { key: 'failed', title: 'Failed', states: ['interrupted'] },
  { key: 'done', title: 'Done', states: ['completed', 'cancelled', 'blocked'] },
];
const DOWNLOAD_ICONS = {
  file: ['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z', 'M14 3v5h5'],
  video: ['M5 6h9a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z', 'M16 10l5-3v10l-5-3z'],
  audio: ['M9 18V6l10-2v12', 'M9 18a3 3 0 1 1-3-3 3 3 0 0 1 3 3z', 'M19 16a3 3 0 1 1-3-3 3 3 0 0 1 3 3z'],
  done: ['M5 12.5l4.5 4.5L19 7'],
  failed: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M12 7.5v5.5', 'M12 16.5v.01'],
  waiting: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M12 7v5l3 2'],
  missing: ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', 'M9 10l6 6', 'M15 10l-6 6'],
  pause: ['M9 5v14', 'M15 5v14'],
  play: ['M8 5l11 7-11 7z'],
  cancel: ['M6 6l12 12', 'M18 6L6 18'],
  retry: ['M20 12a8 8 0 1 1-2.3-5.7', 'M20 4v5h-5'],
  more: ['M6 9l6 6 6-6'],
  less: ['M6 15l6-6 6 6'],
  grip: ['M9 6h.01', 'M15 6h.01', 'M9 12h.01', 'M15 12h.01', 'M9 18h.01', 'M15 18h.01'],
};

let downloadItems = [];
let downloadFilter = 'all';
let downloadLayout = '';
const downloadRows = new Map(); // id -> { shape, node, meta, bar }
const openDownloadDetails = new Set();
let downloadSettings = null; // the night window and speed limit, for the page's texts
let draggedDownload = 0;

// Times of day: minutes after midnight <-> "01:00" (what a time field holds) and "1:00 AM".
function minutesToTime(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function timeToMinutes(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value ?? '');
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function clockText(minutes) {
  const date = new Date(2000, 0, 1, Math.floor(minutes / 60), minutes % 60);
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function nightText() {
  return `${clockText(downloadSettings.downloadNightFrom)}–${clockText(downloadSettings.downloadNightTo)}`;
}

function inNight(now = new Date()) {
  const minutes = now.getHours() * 60 + now.getMinutes();
  const { downloadNightFrom: from, downloadNightTo: to } = downloadSettings;
  return from <= to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
}

// When a waiting download starts.
function waitingText(entry) {
  if (!entry.deferred) return 'Waiting for its turn';
  if (entry.startAt > Date.now()) {
    const at = new Date(entry.startAt);
    const sameDay = at.toDateString() === new Date().toDateString();
    const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return `Starts at ${time}${sameDay ? '' : ` on ${at.toLocaleDateString([], { weekday: 'long' })}`}`;
  }
  if (!entry.startAt && downloadSettings?.downloadNightOnly && !inNight()) return `Waits for the night (${nightText()})`;
  return 'Waiting for its turn';
}

const CHECKSUM_TEXT = {
  checking: 'checking the checksum…',
  match: 'checksum matches',
  mismatch: 'checksum does NOT match',
  error: 'the checksum could not be checked',
};

function downloadIcon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of DOWNLOAD_ICONS[name]) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

function iconButton(icon, label, onClick, className = '') {
  const node = button('', onClick, `icon-action ${className}`.trim());
  node.append(downloadIcon(icon));
  node.setAttribute('aria-label', label);
  node.title = label;
  return node;
}

function groupOf(entry) {
  return DOWNLOAD_GROUPS.find((group) => group.states.includes(entry.state))?.key ?? 'done';
}

function formatLeft(entry) {
  if (!(entry.speed > 0) || !(entry.total > entry.received)) return '';
  const seconds = Math.round((entry.total - entry.received) / entry.speed);
  if (seconds < 60) return `${seconds} s left`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min left`;
  return `${Math.floor(seconds / 3600)} h ${Math.round((seconds % 3600) / 60)} min left`;
}

function downloadStatus(entry) {
  const done = formatBytes(entry.received);
  const size = entry.total > 0 ? `${done} of ${formatBytes(entry.total)}` : done;
  const percent = entry.total > 0 ? Math.floor((entry.received / entry.total) * 100) : null;
  switch (entry.state) {
    case 'progressing': {
      const parts = [size];
      if (entry.speed > 0) parts.push(`${formatBytes(entry.speed)}/s`);
      const left = formatLeft(entry);
      if (left) parts.push(left);
      if (entry.restored) parts.push('picked up after a restart');
      return parts.join(' · ');
    }
    case 'paused': return `Paused · ${size}`;
    case 'queued': return entry.total > 0 ? `${waitingText(entry)} · ${formatBytes(entry.total)}` : waitingText(entry);
    case 'interrupted': {
      const where = percent === null ? 'Failed' : `Failed at ${percent}%`;
      if (entry.retry === 'resume') return `${where} · Retry picks up where it stopped`;
      if (entry.retry === 'restart') return `${where} · the server can't resume it, so Retry starts over`;
      return `${where} · it was in a private tab that has closed`;
    }
    case 'completed': {
      if (entry.missing) return 'The file was moved or deleted';
      const parts = ['Completed', formatBytes(entry.received), new Date(entry.finishedAt || entry.startedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })];
      if (entry.checksum?.result) parts.push(CHECKSUM_TEXT[entry.checksum.result]);
      return parts.join(' · ');
    }
    case 'cancelled': return 'Cancelled';
    case 'blocked': return 'Blocked: this file type is not allowed';
    default: return entry.state;
  }
}

function downloadIconName(entry) {
  if (entry.state === 'completed') return entry.missing ? 'missing' : 'done';
  if (entry.state === 'interrupted' || entry.state === 'blocked') return 'failed';
  if (entry.state === 'queued') return 'waiting';
  return entry.kind === 'video' || entry.kind === 'audio' ? entry.kind : 'file';
}

function downloadActions(entry) {
  const actions = [];
  const { id } = entry;
  if (entry.state === 'progressing') {
    actions.push(iconButton('pause', `Pause ${entry.filename}`, () => api.downloads.pause(id)));
    actions.push(iconButton('cancel', `Cancel ${entry.filename}`, () => api.downloads.cancel(id)));
  } else if (entry.state === 'paused') {
    actions.push(iconButton('play', `Resume ${entry.filename}`, () => api.downloads.resume(id), 'primary'));
    actions.push(iconButton('cancel', `Cancel ${entry.filename}`, () => api.downloads.cancel(id)));
  } else if (entry.state === 'queued') {
    actions.push(button('Start now', () => api.downloads.resume(id)));
    actions.push(iconButton('cancel', `Cancel ${entry.filename}`, () => api.downloads.cancel(id)));
  } else if (entry.state === 'interrupted') {
    if (entry.retry) actions.push(button('Retry', () => api.downloads.retry(id), 'primary'));
    actions.push(iconButton('cancel', `Remove ${entry.filename} from the list`, () => api.downloads.remove(id)));
  } else if (entry.state === 'completed' && !entry.missing) {
    actions.push(button('Open', () => api.downloads.open(id)));
    actions.push(button('Show in folder', () => api.downloads.show(id)));
  } else {
    if (entry.retry === 'restart' && entry.state !== 'blocked') actions.push(button('Download again', () => api.downloads.retry(id)));
    actions.push(iconButton('cancel', `Remove ${entry.filename} from the list`, () => api.downloads.remove(id)));
  }
  const open = openDownloadDetails.has(id);
  const more = iconButton(open ? 'less' : 'more', open ? 'Hide details' : 'Show details', () => {
    if (openDownloadDetails.has(id)) openDownloadDetails.delete(id);
    else openDownloadDetails.add(id);
    renderDownloads();
  }, 'quiet');
  more.setAttribute('aria-expanded', String(open));
  actions.push(more);
  return actions;
}

// "8 connections, in 11 parts" while a split download runs.
function connectionsText(entry) {
  if (!entry.parts) return 'One connection';
  if (entry.state !== 'progressing') return `${entry.parts.length} parts`;
  return `${entry.connections} connection${entry.connections === 1 ? '' : 's'} at once, in ${entry.parts.length} parts`;
}

function downloadDetails(entry, row) {
  const details = element('dl', 'dl-details');
  const add = (term, value) => {
    const pair = element('div');
    pair.append(element('dt', undefined, term), element('dd', undefined, value));
    pair.lastChild.title = value;
    details.append(pair);
  };
  add('From', entry.url);
  add(entry.state === 'completed' ? 'Saved to' : 'Saving to', entry.path || 'Not chosen yet');
  if (['progressing', 'paused', 'queued'].includes(entry.state)) {
    add('Connections', connectionsText(entry));
    row.connections = details.lastChild.lastChild;
  }
  const extras = element('div', 'dl-extras');
  if (['progressing', 'paused', 'queued'].includes(entry.state)) {
    const label = element('label', 'check');
    const box = element('input');
    box.type = 'checkbox';
    box.checked = entry.openWhenDone;
    box.addEventListener('change', () => api.downloads.openWhenDone(entry.id, box.checked));
    label.append(box, ' Open when done');
    extras.append(label);
  }
  if (!['cancelled', 'blocked'].includes(entry.state) && !entry.missing) details.append(checksumField(entry));
  if (entry.isPrivate) extras.append(element('span', 'note', 'From a private tab: not kept after the browser closes'));
  extras.append(button('Copy link', () => api.downloads.copyLink(entry.id), 'link-button'));
  details.append(extras);
  return details;
}

// The SHA-256 a download should have: shown once set, with how the check went; otherwise a field
// to paste it into (checked at once if the download is finished, else when it finishes).
function checksumField(entry) {
  const pair = element('div', 'dl-checksum');
  pair.append(element('dt', undefined, 'SHA-256'));
  const value = element('dd');
  if (entry.checksum) {
    const result = entry.checksum.result || (entry.state === 'completed' ? '' : 'checked when it finishes');
    value.append(element('code', undefined, entry.checksum.expected));
    if (result) value.append(element('span', `sum-result ${entry.checksum.result}`, ` · ${CHECKSUM_TEXT[result] ?? result}`));
  } else {
    const input = element('input');
    input.type = 'text';
    input.spellcheck = false;
    input.maxLength = 100;
    input.placeholder = 'Paste the SHA-256 the site gives';
    input.setAttribute('aria-label', `SHA-256 for ${entry.filename}`);
    const note = element('span', 'note');
    const check = button(entry.state === 'completed' ? 'Check' : 'Check when done', async () => {
      if (!(await api.downloads.checksum(entry.id, input.value))) note.textContent = ' That is not a SHA-256 (64 letters and digits).';
    });
    input.addEventListener('keydown', (event) => { if (event.key === 'Enter') check.click(); });
    value.append(input, check, note);
  }
  pair.append(value);
  return pair;
}

// What decides a row's buttons and parts; while it stays the same, only its text and bar change.
function downloadShape(entry) {
  return [entry.state, entry.missing, entry.retry, entry.openWhenDone, openDownloadDetails.has(entry.id), entry.total > 0, entry.parts?.length ?? 0,
    entry.checksum ? `${entry.checksum.expected}:${entry.checksum.result}` : ''].join('|');
}

function buildDownloadRow(entry) {
  const node = element('div', `row dl-row ${groupOf(entry)}`);
  node.dataset.id = String(entry.id);
  const top = element('div', 'dl-top');
  if (entry.state === 'queued') top.append(queueHandle(entry, node));
  top.append(element('div', `dl-icon ${downloadIconName(entry)}`));
  top.firstChild.append(downloadIcon(downloadIconName(entry)));
  const main = element('div', 'main');
  const name = element('div', 'name', entry.filename);
  name.title = entry.filename;
  if (entry.kind !== 'file') name.append(element('span', 'kind', ` · saved ${entry.kind}`));
  const meta = element('div', `meta ${entry.state}`);
  main.append(name, meta);
  let bar = null;
  let fills = null;
  if (['progressing', 'paused', 'queued'].includes(entry.state) && entry.total > 0 && entry.parts) {
    // One bar per part, as wide as the part, filling as it comes in.
    bar = element('div', `dl-parts ${entry.state === 'progressing' ? '' : 'idle'}`.trim());
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    bar.setAttribute('aria-label', entry.filename);
    fills = [...entry.parts].sort((a, b) => a[0] - b[0]).map(([start, end]) => {
      const part = element('div', 'dl-part');
      part.style.flexGrow = String(end - start + 1);
      const fill = element('div', 'dl-part-fill');
      part.append(fill);
      bar.append(part);
      return { start, fill };
    });
    main.append(bar);
  } else if (['progressing', 'paused', 'queued'].includes(entry.state) && entry.total > 0) {
    bar = element('progress', entry.state === 'progressing' ? '' : 'idle');
    bar.max = 1000;
    bar.setAttribute('aria-label', entry.filename);
    main.append(bar);
  }
  const actions = element('div', 'actions');
  actions.append(...downloadActions(entry));
  top.append(main, actions);
  node.append(top);
  const row = { node, meta, bar, fills, connections: null };
  if (openDownloadDetails.has(entry.id)) node.append(downloadDetails(entry, row));
  return row;
}

// Waiting downloads start in the order shown; drag one by its handle to change it, or use the
// arrow keys on the handle.
function queueHandle(entry, node) {
  const handle = iconButton('grip', `Move ${entry.filename} in the queue (drag, or use the arrow keys)`, () => {}, 'quiet handle');
  handle.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const order = waitingOrder();
    const at = order.indexOf(entry.id);
    if (event.key === 'ArrowUp' && at > 0) api.downloads.move(entry.id, order[at - 1]);
    if (event.key === 'ArrowDown' && at >= 0 && at < order.length - 1) api.downloads.move(entry.id, order[at + 2] ?? 0);
    pendingFocus = entry.id;
  });
  handle.addEventListener('mousedown', () => { node.draggable = true; });
  node.addEventListener('dragstart', (event) => {
    draggedDownload = entry.id;
    event.dataTransfer.effectAllowed = 'move';
    node.classList.add('dragging');
  });
  node.addEventListener('dragend', () => {
    node.draggable = false;
    node.classList.remove('dragging');
    draggedDownload = 0;
    for (const row of document.querySelectorAll('.dl-row.drop-before')) row.classList.remove('drop-before');
  });
  node.addEventListener('dragover', (event) => {
    if (!draggedDownload || draggedDownload === entry.id) return;
    event.preventDefault();
    node.classList.add('drop-before');
  });
  node.addEventListener('dragleave', () => node.classList.remove('drop-before'));
  node.addEventListener('drop', (event) => {
    event.preventDefault();
    node.classList.remove('drop-before');
    if (draggedDownload && draggedDownload !== entry.id) api.downloads.move(draggedDownload, entry.id);
  });
  return handle;
}

let pendingFocus = 0;

function waitingOrder() {
  return downloadItems.filter((entry) => entry.state === 'queued').sort((a, b) => a.order - b.order).map((entry) => entry.id);
}

function updateDownloadRow(row, entry) {
  const status = downloadStatus(entry);
  if (row.meta.textContent !== status) row.meta.textContent = status;
  if (row.fills) {
    const byStart = new Map(entry.parts.map(([start, end, pos]) => [start, (pos - start) / (end - start + 1)]));
    for (const { start, fill } of row.fills) fill.style.width = `${Math.min(100, (byStart.get(start) ?? 0) * 100).toFixed(1)}%`;
    row.bar.setAttribute('aria-valuenow', String(Math.floor((entry.received / entry.total) * 100)));
  } else if (row.bar) {
    row.bar.value = Math.round((entry.received / entry.total) * 1000);
  }
  if (row.connections) {
    const text = connectionsText(entry);
    if (row.connections.textContent !== text) row.connections.textContent = text;
  }
}

function matchesDownload(entry, query) {
  if (!query) return true;
  return entry.filename.toLowerCase().includes(query) || entry.url.toLowerCase().includes(query);
}

function renderDownloads(items = downloadItems) {
  downloadItems = items;
  const query = $('downloadSearch').value.trim().toLowerCase();
  const counts = { all: items.length };
  for (const group of DOWNLOAD_GROUPS) counts[group.key] = items.filter((entry) => groupOf(entry) === group.key).length;
  for (const chip of document.querySelectorAll('#downloadFilters button')) {
    const key = chip.dataset.filter;
    chip.setAttribute('aria-pressed', String(key === downloadFilter));
    chip.textContent = `${chip.dataset.label} ${counts[key] ?? 0}`;
  }
  const running = items.filter((entry) => entry.state === 'progressing' || entry.state === 'queued').length;
  const paused = items.filter((entry) => entry.state === 'paused').length;
  $('downloadsPauseAll').hidden = running === 0 && paused === 0;
  $('downloadsPauseAll').textContent = running > 0 ? 'Pause all' : 'Resume all';
  $('downloadsClear').disabled = !items.some((entry) => ['completed', 'cancelled', 'blocked'].includes(entry.state));
  const speed = items.reduce((sum, entry) => sum + (entry.state === 'progressing' ? entry.speed : 0), 0);
  $('downloadSpeed').textContent = speed > 0 ? `${formatBytes(speed)}/s in all` : '';

  const shown = items.filter((entry) => (downloadFilter === 'all' || groupOf(entry) === downloadFilter) && matchesDownload(entry, query));
  // Rows whose buttons or parts changed are built again; the rest are kept.
  const live = new Set(shown.map((entry) => entry.id));
  for (const id of downloadRows.keys()) if (!live.has(id)) downloadRows.delete(id);
  let rebuilt = false;
  for (const entry of shown) {
    const shape = downloadShape(entry);
    let row = downloadRows.get(entry.id);
    if (!row || row.shape !== shape) {
      row = { shape, ...buildDownloadRow(entry) };
      downloadRows.set(entry.id, row);
      rebuilt = true;
    }
    updateDownloadRow(row, entry);
  }

  // The list itself is only put together again when its rows or their order changed.
  const grouped = DOWNLOAD_GROUPS.map((group) => {
    const entries = shown.filter((entry) => groupOf(entry) === group.key);
    if (group.key === 'waiting') entries.sort((a, b) => a.order - b.order);
    return { group, entries };
  });
  const layout = `${downloadFilter}|${query}|${grouped.map(({ group, entries }) => `${group.key}:${entries.map((entry) => entry.id).join(',')}`).join('|')}`;
  if (!rebuilt && layout === downloadLayout) return;
  downloadLayout = layout;
  const list = $('downloadList');
  if (items.length === 0) {
    list.replaceChildren(element('p', 'empty', 'No downloads yet. Files you download, and videos you save, are listed here.'));
    return;
  }
  if (shown.length === 0) {
    list.replaceChildren(element('p', 'empty', query ? 'No downloads match.' : 'Nothing here.'));
    return;
  }
  const parts = [];
  for (const { group, entries } of grouped) {
    if (entries.length === 0) continue;
    const section = element('section', 'dl-group');
    const heading = element('h3', undefined, group.title);
    if (group.key === 'waiting') heading.append(element('span', 'hint', ' · they start in this order; drag to change it'));
    section.append(heading, ...entries.map((entry) => downloadRows.get(entry.id).node));
    parts.push(section);
  }
  list.replaceChildren(...parts);
  // A row moved with the keyboard keeps the focus on its handle.
  if (pendingFocus) {
    document.querySelector(`.dl-row[data-id="${pendingFocus}"] .handle`)?.focus();
    pendingFocus = 0;
  }
}

function showDownloadSettings(settings) {
  downloadSettings = settings;
  const kilobytes = settings.speedLimitKBps;
  $('downloadLimit').textContent = kilobytes > 0 ? `Speed limit: ${formatBytes(kilobytes * 1024)}/s` : 'Speed limit: none';
  $('downloadLimit').classList.toggle('on', kilobytes > 0);
}

// "When all downloads finish", and its countdown once they have.
let whenDoneTimer = null;
function showWhenDone(state) {
  $('whenDone').value = state.action;
  clearInterval(whenDoneTimer);
  $('whenDoneBanner').hidden = !state.endsAt;
  if (!state.endsAt) return;
  const tick = () => {
    const seconds = Math.max(0, Math.ceil((state.endsAt - Date.now()) / 1000));
    $('whenDoneText').textContent = `Downloads finished. The computer will ${state.action === 'sleep' ? 'sleep' : 'shut down'} in ${seconds} s.`;
  };
  tick();
  whenDoneTimer = setInterval(tick, 500);
}

async function loadDownloads() {
  const [items, settings, whenDone] = await Promise.all([api.downloads.list(), api.settings.get(), api.downloads.whenDone()]);
  showDownloadSettings(settings);
  showWhenDone(whenDone);
  renderDownloads(items);
}

function bindDownloads() {
  $('downloadSearch').addEventListener('input', () => renderDownloads());
  for (const chip of document.querySelectorAll('#downloadFilters button')) {
    chip.addEventListener('click', () => {
      downloadFilter = chip.dataset.filter;
      renderDownloads();
    });
  }
  $('downloadsPauseAll').addEventListener('click', () => (
    downloadItems.some((entry) => entry.state === 'progressing' || entry.state === 'queued') ? api.downloads.pauseAll() : api.downloads.resumeAll()
  ));
  $('downloadsClear').addEventListener('click', () => api.downloads.clear());
  $('whenDone').addEventListener('change', async () => showWhenDone(await api.downloads.setWhenDone($('whenDone').value)));
  $('whenDoneCancel').addEventListener('click', async () => showWhenDone(await api.downloads.cancelWhenDone()));
  api.onWhenDone(showWhenDone);
  $('downloadsAdd').addEventListener('click', openAddLinks);
  bindAddLinks();
  // The limit is set in Settings, with the other download settings.
  $('downloadLimit').addEventListener('click', async () => {
    show('settings');
    renderSettings(await api.settings.get());
    $('speedLimitField').scrollIntoView({ block: 'center' });
    $(($('speedLimitOn').checked ? 'speedLimitValue' : 'speedLimitNone')).focus();
  });
}
