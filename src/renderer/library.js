'use strict';

const api = window.browserApi;
const PAGES = ['history', 'downloads', 'recordings', 'settings'];
const TITLES = { history: 'History', downloads: 'Downloads', recordings: 'Recordings', settings: 'Settings' };
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

// ---------- History ----------
async function loadHistory() {
  const { enabled, entries } = await api.history.list($('historySearch').value.trim());
  $('historyOff').hidden = enabled;
  const list = $('historyList');
  list.replaceChildren();
  if (entries.length === 0) {
    list.append(element('p', 'empty', $('historySearch').value ? 'No matching pages.' : 'No history yet.'));
    return;
  }
  for (const entry of entries) {
    const row = element('div', 'row');
    const main = element('div', 'main');
    const open = button(entry.title || entry.url, () => api.tabs.open(entry.url), 'title');
    open.title = entry.url;
    main.append(open, element('div', 'meta', `${entry.url}  ·  ${formatDate(entry.time)}`));
    const actions = element('div', 'actions');
    actions.append(button('Remove', async () => { await api.history.remove(entry.id); loadHistory(); }));
    row.append(main, actions);
    list.append(row);
  }
}

// ---------- Downloads ----------
function renderDownloads(items) {
  const list = $('downloadList');
  list.replaceChildren();
  if (items.length === 0) {
    list.append(element('p', 'empty', 'No downloads in this session.'));
    return;
  }
  for (const item of items) {
    const row = element('div', 'row');
    row.append(element('div', 'icon', item.state === 'completed' ? '✅' : item.state === 'progressing' ? '⬇️' : '⚠️'));
    const main = element('div', 'main');
    main.append(element('div', 'name', item.filename));
    const total = item.total > 0 ? formatBytes(item.total) : 'unknown size';
    const status = {
      progressing: `${formatBytes(item.received)} of ${total}`,
      paused: `Paused · ${formatBytes(item.received)} of ${total}`,
      completed: `Completed · ${formatBytes(item.received)}`,
      cancelled: 'Cancelled',
      interrupted: 'Failed',
    }[item.state] ?? item.state;
    main.append(element('div', 'meta', status));
    if (item.state === 'progressing' && item.total > 0) {
      const bar = element('progress');
      bar.max = item.total;
      bar.value = item.received;
      main.append(bar);
    }
    const actions = element('div', 'actions');
    if (item.state === 'progressing' || item.state === 'paused') {
      actions.append(button('Cancel', () => api.downloads.cancel(item.id)));
    } else if (item.state === 'completed') {
      actions.append(button('Show in folder', () => api.downloads.show(item.id)));
    }
    row.append(main, actions);
    list.append(row);
  }
}

// ---------- Recordings ----------
function showRecordingMessage(text) {
  $('recMessage').textContent = text;
  $('recMessage').hidden = !text;
}

const RENAME_ERRORS = {
  exists: 'A file with that name already exists.',
  'invalid-name': 'That name is not allowed.',
  failed: 'The file could not be renamed.',
};

function startRename(row, entry) {
  const main = row.querySelector('.main');
  const dot = entry.name.lastIndexOf('.');
  const input = element('input');
  input.type = 'text';
  input.value = dot > 0 ? entry.name.slice(0, dot) : entry.name;
  input.maxLength = 100;
  main.replaceChildren(input);
  input.focus();
  input.select();

  const actions = row.querySelector('.actions');
  const save = async () => {
    const result = await api.recordings.rename(entry.name, input.value);
    if (result.ok) {
      showRecordingMessage('');
      loadRecordings();
    } else {
      showRecordingMessage(RENAME_ERRORS[result.reason] ?? RENAME_ERRORS.failed);
    }
  };
  actions.replaceChildren(button('Save', save), button('Cancel', () => { showRecordingMessage(''); loadRecordings(); }));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') save();
    else if (event.key === 'Escape') loadRecordings();
  });
}

function deleteButton(entry) {
  const node = button('Delete', async () => {
    if (!node.dataset.confirm) {
      node.dataset.confirm = '1';
      node.textContent = 'Click again to delete';
      setTimeout(() => { delete node.dataset.confirm; node.textContent = 'Delete'; }, 3000);
      return;
    }
    const result = await api.recordings.delete(entry.name);
    showRecordingMessage(result.ok ? '' : 'The file could not be deleted.');
    loadRecordings();
  }, 'danger');
  return node;
}

async function loadRecordings() {
  const { folder, entries } = await api.recordings.list();
  $('recFolder').textContent = folder;
  const list = $('recList');
  list.replaceChildren();
  if (entries.length === 0) {
    list.append(element('p', 'empty', 'No recordings or screenshots yet. Use ● to record or 📷 for a screenshot.'));
    return;
  }
  for (const entry of entries) {
    const row = element('div', 'row');
    row.append(element('div', 'icon', entry.type === 'video' ? '🎬' : '🖼️'));
    const main = element('div', 'main');
    main.append(element('div', 'name', entry.name));
    const parts = [];
    if (entry.type === 'video' && entry.durationMs !== null) parts.push(formatDuration(entry.durationMs));
    parts.push(formatBytes(entry.size), formatDate(entry.modified));
    main.append(element('div', 'meta', parts.join('  ·  ')));
    const actions = element('div', 'actions');
    actions.append(
      button('Open', async () => { if (!(await api.recordings.open(entry.name))) showRecordingMessage('The file could not be opened.'); }),
      button('Show in folder', () => api.recordings.reveal(entry.name)),
      button('Rename', () => startRename(row, entry)),
      deleteButton(entry),
    );
    row.append(main, actions);
    list.append(row);
  }
}

// ---------- Settings ----------
function fillSelect(select, options, value) {
  select.replaceChildren(...options.map(({ key, label }) => {
    const option = element('option', undefined, label);
    option.value = key;
    return option;
  }));
  select.value = value;
}

function renderSettings(settings) {
  $('homePage').value = settings.homePage;
  fillSelect($('searchEngine'), settings.engines.map((engine) => ({ key: engine.key, label: engine.name })), settings.searchEngine);
  $('restoreTabs').checked = settings.restoreTabs;
  $('historyEnabled').checked = settings.historyEnabled;
  fillSelect($('recordingQuality'), settings.qualities.map((quality) => ({ key: quality.key, label: quality.label })), settings.recordingQuality);
  $('qualityHint').textContent = settings.qualities.find((quality) => quality.key === settings.recordingQuality)?.description ?? '';
  $('recordingFollowTab').checked = settings.recordingFollowTab;
  $('folderPath').textContent = settings.recordingFolder;
}

async function saveSetting(patch) {
  renderSettings(await api.settings.update(patch));
}

function bindSettings() {
  $('homePage').addEventListener('change', () => saveSetting({ homePage: $('homePage').value.trim() }));
  $('searchEngine').addEventListener('change', () => saveSetting({ searchEngine: $('searchEngine').value }));
  $('restoreTabs').addEventListener('change', () => saveSetting({ restoreTabs: $('restoreTabs').checked }));
  $('historyEnabled').addEventListener('change', () => saveSetting({ historyEnabled: $('historyEnabled').checked }));
  $('recordingQuality').addEventListener('change', () => saveSetting({ recordingQuality: $('recordingQuality').value }));
  $('recordingFollowTab').addEventListener('change', () => saveSetting({ recordingFollowTab: $('recordingFollowTab').checked }));
  $('folderChange').addEventListener('click', async () => renderSettings(await api.settings.chooseFolder()));
  $('folderOpen').addEventListener('click', () => api.recordings.openFolder());
  $('settingsClearHistory').addEventListener('click', async () => {
    await api.history.clear();
    $('settingsHistoryMsg').textContent = 'History cleared.';
    $('settingsHistoryMsg').hidden = false;
  });
}

// ---------- Navigation ----------
const loaders = {
  history: loadHistory,
  downloads: async () => renderDownloads(await api.downloads.list()),
  recordings: loadRecordings,
  settings: async () => renderSettings(await api.settings.get()),
};

function show(page) {
  current = PAGES.includes(page) ? page : 'history';
  for (const name of PAGES) {
    $(`page-${name}`).hidden = name !== current;
    document.querySelector(`[data-page="${name}"]`).classList.toggle('active', name === current);
  }
  document.title = TITLES[current];
  window.history.replaceState(null, '', `#${current}`);
  loaders[current]();
}

for (const name of PAGES) {
  document.querySelector(`[data-page="${name}"]`).addEventListener('click', () => show(name));
}
$('historySearch').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadHistory, 200);
});
$('historyClear').addEventListener('click', async () => {
  await api.history.clear();
  loadHistory();
});
$('recOpenFolder').addEventListener('click', () => api.recordings.openFolder());
bindSettings();

api.onLibraryShow(show);
api.onDownloads((items) => { if (current === 'downloads') renderDownloads(items); });
api.onRecordingsChanged(() => { if (current === 'recordings') loadRecordings(); });

show(location.hash.slice(1));
