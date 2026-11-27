'use strict';

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

// ---------- Bookmarks ----------
// The folder tree on the left, the open folder (or search results) on the right. Every change
// goes to the main process, which sends back the whole tree.
let bookmarkTree = null;
let pageIcons = {}; // site icons of bookmarks, by address
let openFolderId = 'bar';
const selectedBookmarks = new Set();
let draggedBookmark = null;
const collapsedFolders = new Set(); // folders whose subfolders the tree hides, for this visit
const BOOKMARK_DRAG_TYPE = 'application/x-simple-browser-bookmark';
const SVG_NS = 'http://www.w3.org/2000/svg';

function showBookmarksMessage(text) {
  $('bookmarksMessage').textContent = text;
  $('bookmarksMessage').hidden = !text;
}

function bookmarkRoots() {
  return [bookmarkTree.bar, bookmarkTree.other];
}

// { node, parent, index, path } for an id, or null.
function findBookmark(id) {
  const search = (folder, path) => {
    for (let index = 0; index < folder.children.length; index += 1) {
      const node = folder.children[index];
      if (node.id === id) return { node, parent: folder, index, path: [...path, folder] };
      if (node.type === 'folder') {
        const found = search(node, [...path, folder]);
        if (found) return found;
      }
    }
    return null;
  };
  for (const root of bookmarkRoots()) {
    if (root.id === id) return { node: root, parent: null, index: -1, path: [] };
    const found = search(root, []);
    if (found) return found;
  }
  return null;
}

function linksIn(node) {
  return node.type === 'link' ? [node] : node.children.flatMap(linksIn);
}

function searchBookmarks(query) {
  const out = [];
  const walk = (folder, names) => {
    for (const node of folder.children) {
      if (node.type === 'folder') walk(node, [...names, node.title]);
      else if (`${node.title} ${node.url}`.toLowerCase().includes(query)) out.push({ node, folder: names.join(' › ') });
    }
  };
  bookmarkRoots().forEach((root) => walk(root, [root.title]));
  return out;
}

function folderSvg(muted) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', `folder-icon${muted ? ' muted' : ''}`);
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z');
  svg.append(path);
  return svg;
}

function setBookmarkTree(tree) {
  bookmarkTree = tree;
  for (const id of [...selectedBookmarks]) if (!findBookmark(id)) selectedBookmarks.delete(id);
  renderBookmarkPage();
}

async function loadBookmarks() {
  const tree = await api.bookmarks.list();
  bookmarkTree = tree;
  pageIcons = await api.bookmarks.icons(bookmarkRoots().flatMap(linksIn).map((link) => link.url));
  setBookmarkTree(tree);
}

// From "Edit…" in the bar's right-click menu: open this bookmark's folder and edit it.
async function revealBookmark(id) {
  show('bookmarks');
  await loadBookmarks();
  const found = findBookmark(id);
  if (!found) return;
  $('bookmarksSearch').value = '';
  openFolderId = found.parent?.id ?? found.node.id;
  renderBookmarkPage();
  const row = document.querySelector(`#bookmarkList .bm-row[data-id="${id}"]`);
  if (row && found.parent) startBookmarkEdit(row, found.node);
}

// ---------- Dragging: reorder in a folder, or drop into a folder ----------
function clearDropMarks() {
  document.querySelectorAll('.drop-before, .drop-after, .drop-into').forEach((node) => node.classList.remove('drop-before', 'drop-after', 'drop-into'));
}

function startBookmarkDrag(node, id) {
  node.draggable = true;
  node.addEventListener('dragstart', (event) => {
    draggedBookmark = id;
    event.dataTransfer.setData(BOOKMARK_DRAG_TYPE, id);
    event.dataTransfer.effectAllowed = 'move';
    node.classList.add('dragging');
  });
  node.addEventListener('dragend', () => {
    draggedBookmark = null;
    node.classList.remove('dragging');
    clearDropMarks();
  });
}

// `place(event)` says where a drop on `node` goes: { parentId, index, mark } or null.
function acceptBookmarkDrop(node, place) {
  node.addEventListener('dragover', (event) => {
    if (!draggedBookmark || !event.dataTransfer.types.includes(BOOKMARK_DRAG_TYPE)) return;
    const target = place(event);
    clearDropMarks();
    if (!target) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    node.classList.add(target.mark);
  });
  node.addEventListener('dragleave', () => node.classList.remove('drop-before', 'drop-after', 'drop-into'));
  node.addEventListener('drop', async (event) => {
    const id = event.dataTransfer.getData(BOOKMARK_DRAG_TYPE);
    const target = id && place(event);
    clearDropMarks();
    if (!target) return;
    event.preventDefault();
    setBookmarkTree(await api.bookmarks.move(id, target.parentId, target.index));
  });
}

// A drop on a row: into it if it is a folder and the pointer is over its middle, else before or
// after it. The index counts the folder's items as they are once the dragged one is taken out.
function rowDropPlace(row, node, index) {
  return (event) => {
    if (draggedBookmark === node.id) return null;
    const box = row.getBoundingClientRect();
    const at = (event.clientY - box.top) / box.height;
    if (node.type === 'folder' && at > 0.25 && at < 0.75) return { parentId: node.id, index: 10000, mark: 'drop-into' };
    const dragged = findBookmark(draggedBookmark);
    const sameFolder = dragged?.parent?.id === openFolderId && dragged.index < index;
    const before = at <= 0.5;
    return { parentId: openFolderId, index: index + (before ? 0 : 1) - (sameFolder ? 1 : 0), mark: before ? 'drop-before' : 'drop-after' };
  };
}

// A drop on a folder in the tree: into it over its middle (or anywhere on a top folder), else
// before or after it among its parent's items. Never into the dragged folder or one inside it.
function treeDropPlace(row, folder) {
  return (event) => {
    if (!draggedBookmark || draggedBookmark === folder.id) return null;
    const target = findBookmark(folder.id);
    if (!target || target.path.some((part) => part.id === draggedBookmark)) return null;
    const box = row.getBoundingClientRect();
    const at = (event.clientY - box.top) / box.height;
    if (!target.parent || (at > 0.25 && at < 0.75)) return { parentId: folder.id, index: 10000, mark: 'drop-into' };
    const dragged = findBookmark(draggedBookmark);
    const sameParent = dragged?.parent?.id === target.parent.id && dragged.index < target.index;
    const before = at <= 0.5;
    return { parentId: target.parent.id, index: target.index + (before ? 0 : 1) - (sameParent ? 1 : 0), mark: before ? 'drop-before' : 'drop-after' };
  };
}

// ---------- Drawing ----------
function renderFolderTree() {
  const box = $('bookmarkFolders');
  box.replaceChildren();
  // The open folder is always shown: the folders around it are expanded.
  for (const part of findBookmark(openFolderId)?.path ?? []) collapsedFolders.delete(part.id);
  const add = (folder, depth) => {
    const subfolders = folder.children.filter((node) => node.type === 'folder');
    const collapsed = collapsedFolders.has(folder.id);
    const row = element('div', `tree-row${folder.id === openFolderId ? ' active' : ''}`);
    row.style.paddingLeft = `${4 + depth * 16}px`;
    const twisty = element('button', 'twisty', subfolders.length ? (collapsed ? '▶' : '▼') : '');
    twisty.type = 'button';
    if (subfolders.length) {
      twisty.setAttribute('aria-expanded', String(!collapsed));
      twisty.setAttribute('aria-label', `${collapsed ? 'Expand' : 'Collapse'} ${folder.title}`);
      twisty.addEventListener('click', () => {
        if (collapsed) collapsedFolders.delete(folder.id);
        else collapsedFolders.add(folder.id);
        renderFolderTree();
      });
    } else {
      twisty.disabled = true;
      twisty.setAttribute('aria-hidden', 'true');
      twisty.tabIndex = -1;
    }
    const item = element('button', `tree-item${folder.id === openFolderId ? ' active' : ''}`);
    item.type = 'button';
    item.dataset.id = folder.id;
    if (folder.id === openFolderId) item.setAttribute('aria-current', 'true');
    item.append(folderSvg(folder.id === 'other'), element('span', 'label', folder.title), element('span', 'count', String(folder.children.length)));
    item.addEventListener('click', () => {
      openFolderId = folder.id;
      selectedBookmarks.clear();
      $('bookmarksSearch').value = '';
      renderBookmarkPage();
    });
    // Folders (not the two top ones) can be dragged in the tree to nest or reorder them.
    if (findBookmark(folder.id)?.parent) startBookmarkDrag(row, folder.id);
    acceptBookmarkDrop(row, treeDropPlace(row, folder));
    row.append(twisty, item);
    box.append(row);
    if (!collapsed) for (const node of subfolders) add(node, depth + 1);
  };
  bookmarkRoots().forEach((root) => add(root, 0));
  box.append(element('p', 'tree-note', 'Drop a bookmark on a folder to move it there. Drag folders to nest or reorder them.'));
}

function startBookmarkEdit(row, node) {
  const main = row.querySelector('.main');
  const title = element('input');
  title.type = 'text';
  title.value = node.title;
  title.maxLength = 200;
  title.setAttribute('aria-label', 'Name');
  const fields = [title];
  let url = null;
  if (node.type === 'link') {
    url = element('input');
    url.type = 'text';
    url.value = node.url;
    url.maxLength = 2048;
    url.setAttribute('aria-label', 'Address');
    fields.push(url);
  }
  main.replaceChildren(...fields);
  title.focus();
  title.select();
  const save = async () => {
    const patch = { title: title.value };
    if (url) {
      try {
        const parsed = new URL(url.value.trim());
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('scheme');
        patch.url = parsed.href;
      } catch {
        showBookmarksMessage('The address must start with http:// or https://.');
        url.focus();
        return;
      }
    }
    showBookmarksMessage('');
    setBookmarkTree(await api.bookmarks.update(node.id, patch));
  };
  for (const field of fields) {
    field.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') save();
      else if (event.key === 'Escape') renderBookmarkPage();
    });
  }
  row.querySelector('.actions').replaceChildren(button('Save', save), button('Cancel', () => renderBookmarkPage()));
}

function bookmarkDeleteButton(node) {
  const needsConfirm = node.type === 'folder' && node.children.length > 0;
  const remove = button('Delete', async () => {
    if (needsConfirm && !remove.dataset.confirm) {
      remove.dataset.confirm = '1';
      remove.textContent = `Delete with ${linksIn(node).length} bookmarks?`;
      setTimeout(() => { delete remove.dataset.confirm; remove.textContent = 'Delete'; }, 3000);
      return;
    }
    setBookmarkTree(await api.bookmarks.remove([node.id]));
  }, 'danger');
  return remove;
}

function bookmarkRow(node, index, { searching, folderName }) {
  const row = element('div', 'row bm-row');
  row.dataset.id = node.id;
  if (!searching) {
    row.append(element('span', 'handle', '⋮⋮'));
    startBookmarkDrag(row, node.id);
    acceptBookmarkDrop(row, rowDropPlace(row, node, index));
  }
  const tick = element('input');
  tick.type = 'checkbox';
  tick.checked = selectedBookmarks.has(node.id);
  tick.setAttribute('aria-label', `Select ${node.title}`);
  tick.addEventListener('change', () => {
    if (tick.checked) selectedBookmarks.add(node.id);
    else selectedBookmarks.delete(node.id);
    renderSelectionBar();
  });
  let icon;
  if (node.type === 'folder') {
    icon = folderSvg(false);
  } else if (pageIcons[node.url]) {
    icon = element('img', 'bm-icon');
    icon.src = pageIcons[node.url];
    icon.alt = '';
  } else {
    icon = element('span', 'link-dot');
  }
  row.append(tick, icon);
  const main = element('div', 'main');
  const open = button(node.title, () => {
    if (node.type === 'folder') {
      openFolderId = node.id;
      selectedBookmarks.clear();
      renderBookmarkPage();
    } else {
      api.tabs.open(node.url);
    }
  }, 'title');
  open.title = node.type === 'folder' ? `Open the folder ${node.title}` : node.url;
  const meta = node.type === 'folder'
    ? `Folder · ${node.children.length} item${node.children.length === 1 ? '' : 's'}`
    : searching ? `${node.url}  ·  ${folderName}` : node.url;
  main.append(open, element('div', 'meta', meta));
  const actions = element('div', 'actions');
  if (!searching) {
    const count = findBookmark(openFolderId).node.children.length;
    const up = button('↑', async () => setBookmarkTree(await api.bookmarks.move(node.id, openFolderId, index - 1)));
    up.title = 'Move up';
    up.setAttribute('aria-label', `Move ${node.title} up`);
    up.disabled = index === 0;
    const down = button('↓', async () => setBookmarkTree(await api.bookmarks.move(node.id, openFolderId, index + 1)));
    down.title = 'Move down';
    down.setAttribute('aria-label', `Move ${node.title} down`);
    down.disabled = index === count - 1;
    actions.append(up, down);
  }
  actions.append(button(node.type === 'folder' ? 'Rename' : 'Edit', () => startBookmarkEdit(row, node)), bookmarkDeleteButton(node), bookmarkMoreButton(node));
  row.append(main, actions);
  return row;
}

// ⋯ : open a bookmark in a new or private tab or copy its address; open all of a folder's.
function bookmarkMoreButton(node) {
  const more = button('⋯', () => {
    const run = (action, done) => async () => {
      const ok = await api.bookmarks.action(node.id, action);
      if (ok && done) showBookmarksMessage(done);
    };
    const count = linksIn(node).length;
    const items = node.type === 'link'
      ? [
        { label: 'Open in new tab', onSelect: run('tab') },
        { label: 'Open in private tab', onSelect: run('private') },
        { label: 'Copy address', onSelect: run('copy', `Copied ${node.url}`) },
      ]
      : [{ label: `Open all (${count}) in new tabs`, disabled: count === 0, onSelect: run('open-all', `Opened ${count} bookmark${count === 1 ? '' : 's'} in new tabs.`) }];
    DarkMenu.toggle(more, () => items, () => {
      const box = more.getBoundingClientRect();
      return { x: Math.round(box.right - 210), y: Math.round(box.bottom + 4) };
    });
  }, 'more');
  more.title = 'More actions';
  more.setAttribute('aria-label', `More actions for ${node.title}`);
  more.setAttribute('aria-haspopup', 'menu');
  return more;
}

function renderSelectionBar() {
  const count = selectedBookmarks.size;
  $('bookmarksSelection').hidden = count === 0;
  $('bookmarksSelected').textContent = `${count} selected`;
}

function renderBookmarkPage() {
  if (!bookmarkTree) return;
  if (!findBookmark(openFolderId)) openFolderId = 'bar';
  renderFolderTree();
  const query = $('bookmarksSearch').value.trim().toLowerCase();
  const folder = findBookmark(openFolderId);
  $('bookmarksPath').textContent = query
    ? `Search results for “${$('bookmarksSearch').value.trim()}”`
    : [...folder.path, folder.node].map((part) => part.title).join(' › ');
  const linkCount = query ? 0 : linksIn(folder.node).length;
  $('bookmarksOpenAll').hidden = linkCount === 0;
  $('bookmarksOpenAll').textContent = `Open all (${linkCount}) in new tabs`;
  const list = $('bookmarkList');
  list.replaceChildren();
  if (query) {
    const found = searchBookmarks(query);
    if (found.length === 0) list.append(element('p', 'empty', 'No bookmarks match.'));
    found.forEach(({ node, folder: folderName }, index) => list.append(bookmarkRow(node, index, { searching: true, folderName })));
  } else {
    if (folder.node.children.length === 0) {
      list.append(element('p', 'empty', openFolderId === 'bar'
        ? 'No bookmarks yet. Press ☆ in the address bar to bookmark a page, or import a bookmarks file.'
        : 'This folder is empty. Drag bookmarks here, or use Move to.'));
    }
    folder.node.children.forEach((node, index) => list.append(bookmarkRow(node, index, { searching: false })));
  }
  renderSelectionBar();
}

async function newBookmarkFolder() {
  const parentId = $('bookmarksSearch').value.trim() ? 'bar' : openFolderId;
  $('bookmarksSearch').value = '';
  openFolderId = parentId;
  const result = await api.bookmarks.addFolder(parentId, 'New folder');
  setBookmarkTree(result.tree);
  const row = document.querySelector(`#bookmarkList .bm-row[data-id="${result.id}"]`);
  const found = result.id && findBookmark(result.id);
  if (row && found) startBookmarkEdit(row, found.node);
}

// ---------- Move to… ----------
// A dialog with the folder tree. A folder cannot go into itself or a folder inside it, so those
// are greyed out.
let moveTarget = null;

function renderMoveTree() {
  const moving = [...selectedBookmarks].map(findBookmark).filter(Boolean).map((found) => found.node);
  const blocked = new Set(moving.filter((node) => node.type === 'folder').flatMap(function ids(node) {
    return [node.id, ...node.children.filter((child) => child.type === 'folder').flatMap(ids)];
  }));
  const tree = $('moveDialogTree');
  tree.replaceChildren();
  const walk = (folder, depth) => {
    const row = element('button', `move-folder${folder.id === moveTarget ? ' selected' : ''}`);
    row.type = 'button';
    row.dataset.id = folder.id;
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(folder.id === moveTarget));
    row.style.paddingLeft = `${10 + depth * 18}px`;
    row.disabled = blocked.has(folder.id);
    row.append(folderSvg(folder.id === 'other'), element('span', undefined, folder.title));
    row.addEventListener('click', () => { moveTarget = folder.id; renderMoveTree(); });
    row.addEventListener('dblclick', () => { moveTarget = folder.id; finishMove(); });
    tree.append(row);
    for (const node of folder.children) if (node.type === 'folder') walk(node, depth + 1);
  };
  bookmarkRoots().forEach((root) => walk(root, 0));
  $('moveDialogMove').disabled = !moveTarget || blocked.has(moveTarget);
  tree.querySelector('.selected')?.focus();
}

function openMoveDialog() {
  if (selectedBookmarks.size === 0) return;
  const count = selectedBookmarks.size;
  $('moveDialogNote').textContent = `${count} item${count === 1 ? '' : 's'} selected. Choose a folder.`;
  moveTarget = openFolderId;
  renderMoveTree();
  $('moveDialog').showModal();
  ($('moveDialogTree').querySelector('.selected') ?? $('moveDialogTree').querySelector('button:not(:disabled)'))?.focus();
}

async function finishMove() {
  const target = moveTarget;
  if (!target || $('moveDialogMove').disabled) return;
  $('moveDialog').close();
  let tree = bookmarkTree;
  for (const id of selectedBookmarks) tree = await api.bookmarks.move(id, target, 10000);
  selectedBookmarks.clear();
  setBookmarkTree(tree);
}

// ↑ ↓ move through the folders, Enter moves there; Esc closes (the dialog does that itself).
$('moveDialogTree').addEventListener('keydown', (event) => {
  const rows = [...$('moveDialogTree').querySelectorAll('button:not(:disabled)')];
  const at = rows.findIndex((row) => row.dataset.id === moveTarget);
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const next = rows[Math.max(0, Math.min(rows.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)))];
    if (next) { moveTarget = next.dataset.id; renderMoveTree(); }
  } else if (event.key === 'Enter') {
    event.preventDefault();
    finishMove();
  }
});
$('moveDialogMove').addEventListener('click', finishMove);
$('moveDialogCancel').addEventListener('click', () => $('moveDialog').close());

async function deleteSelectedBookmarks() {
  const ids = [...selectedBookmarks];
  selectedBookmarks.clear();
  setBookmarkTree(await api.bookmarks.remove(ids));
}

async function openAllBookmarks() {
  const opened = await api.bookmarks.open([openFolderId]);
  showBookmarksMessage(`Opened ${opened} bookmark${opened === 1 ? '' : 's'} in new tabs.`);
}

async function importBookmarks() {
  const result = await api.bookmarks.importFile();
  if (result.canceled) return;
  if (!result.ok) {
    showBookmarksMessage(`Could not import: ${result.message}`);
    return;
  }
  const skipped = result.skipped ? ` ${result.skipped} skipped (already bookmarked, or over the limit).` : '';
  showBookmarksMessage(`Imported ${result.added} bookmark${result.added === 1 ? '' : 's'}.${skipped}`);
  loadBookmarks();
}

async function exportBookmarks() {
  const result = await api.bookmarks.exportFile();
  if (result.canceled) return;
  showBookmarksMessage(result.ok ? `Exported ${result.count} bookmark${result.count === 1 ? '' : 's'} to ${result.path}` : `Could not export: ${result.message}`);
}

// ---------- Downloads ----------
// The Downloads page is in library-downloads.js.

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

// ---------- Thumbnails and the player ----------
// A thumbnail loads its file only once it scrolls into view; a video shows a frame from about a
// second in.
const thumbObserver = new IntersectionObserver((seen) => {
  for (const item of seen) {
    if (!item.isIntersecting) continue;
    thumbObserver.unobserve(item.target);
    const media = item.target.firstElementChild;
    media.src = media.dataset.src;
  }
});

function thumbnail(entry) {
  const node = element('button', 'thumb');
  node.type = 'button';
  node.title = entry.type === 'video' ? `Play ${entry.name}` : `View ${entry.name}`;
  let media;
  if (entry.type === 'video') {
    media = element('video');
    media.muted = true;
    media.preload = 'metadata';
    media.addEventListener('loadedmetadata', () => {
      media.currentTime = Number.isFinite(media.duration) ? Math.min(1, media.duration / 2) : 1;
    }, { once: true });
  } else {
    media = element('img');
    media.alt = '';
  }
  media.dataset.src = entry.url;
  node.append(media);
  node.addEventListener('click', () => openPlayer(entry));
  thumbObserver.observe(node);
  return node;
}

let playerEntry = null;
let trim = { start: 0, end: 0 };

// "1:05.3": the times shown while trimming, to a tenth of a second.
function formatTrimTime(ms) {
  const tenths = Math.round(ms / 100);
  const minutes = Math.floor(tenths / 600);
  const seconds = (tenths % 600) / 10;
  return `${minutes}:${seconds < 10 ? '0' : ''}${seconds.toFixed(1)}`;
}

function showTrim() {
  $('trimStart').textContent = formatTrimTime(trim.start);
  $('trimEnd').textContent = formatTrimTime(trim.end);
  $('trimSave').disabled = trim.end <= trim.start;
}

const TRIM_ERRORS = {
  recording: 'This recording is still being recorded.',
  'invalid-range': 'The end must come after the start.',
};

async function saveTrim() {
  const entry = playerEntry;
  $('trimSave').disabled = true;
  $('playerInfo').textContent = 'Saving the trimmed copy…';
  const result = await api.recordings.trim(entry.name, Math.round(trim.start), Math.round(trim.end));
  if (result.ok) {
    $('playerInfo').textContent = `Saved ${result.name} (${formatDuration(result.durationMs)}). It starts at ${formatTrimTime(result.startMs)}, the keyframe at or before your start.`;
    loadRecordings();
  } else {
    $('playerInfo').textContent = TRIM_ERRORS[result.reason] ?? `Could not save the trimmed copy${result.message ? `: ${result.message}` : '.'}`;
  }
  showTrim();
}

function openPlayer(entry) {
  playerEntry = entry;
  const stage = $('playerStage');
  let media;
  if (entry.type === 'video') {
    media = element('video');
    media.controls = true;
    media.autoplay = true;
    media.addEventListener('loadedmetadata', () => {
      $('playerInfo').textContent = Number.isFinite(media.duration) ? `Length ${formatDuration(media.duration * 1000)}` : '';
      trim = { start: 0, end: Number.isFinite(media.duration) ? media.duration * 1000 : 0 };
      showTrim();
      $('trimBar').hidden = false;
    });
  } else {
    media = element('img');
    media.alt = entry.name;
  }
  media.id = 'playerMedia';
  media.src = entry.url;
  stage.replaceChildren(media);
  $('playerTitle').textContent = entry.name;
  $('playerInfo').textContent = '';
  $('trimBar').hidden = true;
  // Markers set while recording: each jumps to its moment.
  const markers = entry.type === 'video' ? entry.markers ?? [] : [];
  $('playerMarkers').replaceChildren(...markers.map((ms, i) => {
    const chip = button(`Marker ${i + 1} · ${formatTrimTime(ms)}`, () => { media.currentTime = ms / 1000; });
    chip.title = `Jump to marker ${i + 1}`;
    return chip;
  }));
  $('playerMarkers').hidden = markers.length === 0;
  $('player').hidden = false;
  $('playerClose').focus();
}

function closePlayer() {
  const media = $('playerMedia');
  if (media?.pause) media.pause();
  $('playerStage').replaceChildren();
  $('player').hidden = true;
  playerEntry = null;
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
  // Recordings that followed you across tabs: "x.webm", "x-part2.webm", ... can be joined.
  const partCount = new Map();
  for (const entry of entries) {
    const match = /^(.+?)(?:-part(\d+))?\.webm$/i.exec(entry.name);
    if (match) partCount.set(match[1], (partCount.get(match[1]) ?? 0) + 1);
  }
  for (const entry of entries) {
    const row = element('div', 'row');
    row.dataset.name = entry.name;
    row.append(thumbnail(entry));
    const main = element('div', 'main');
    main.append(element('div', 'name', entry.name));
    const parts = [];
    if (entry.type === 'video' && entry.durationMs !== null) parts.push(formatDuration(entry.durationMs));
    if (entry.markers?.length) parts.push(`${entry.markers.length} marker${entry.markers.length === 1 ? '' : 's'}`);
    parts.push(formatBytes(entry.size), formatDate(entry.modified));
    main.append(element('div', 'meta', parts.join('  ·  ')));
    const actions = element('div', 'actions');
    actions.append(
      button(entry.type === 'video' ? 'Play' : 'View', () => openPlayer(entry)),
      button('Open', async () => { if (!(await api.recordings.open(entry.name))) showRecordingMessage('The file could not be opened.'); }),
      button('Show in folder', () => api.recordings.reveal(entry.name)),
      button('Rename', () => startRename(row, entry)),
      deleteButton(entry),
    );
    const base = /^(.+?)\.webm$/i.exec(entry.name)?.[1];
    if (base && !/-part\d+$/i.test(base) && (partCount.get(base) ?? 0) > 1) {
      const join = button(`Join ${partCount.get(base)} parts`, async () => {
        join.disabled = true;
        join.textContent = 'Joining…';
        const result = await api.recordings.join(entry.name);
        showRecordingMessage(result.ok
          ? `Joined ${result.parts} parts into ${result.name} (${formatDuration(result.durationMs)}).`
          : TRIM_ERRORS[result.reason] ?? `Could not join the parts${result.message ? `: ${result.message}` : '.'}`);
        loadRecordings();
      }, 'primary');
      actions.prepend(join);
    }
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
  $('showBookmarksBar').checked = settings.showBookmarksBar;
  $('recordingMicrophone').checked = settings.recordingMicrophone;
  fillSelect($('recordingStopAfter'), settings.stopAfterChoices.map((minutes) => ({
    key: String(minutes),
    label: minutes === 0 ? 'Never' : minutes < 60 || minutes % 60 ? `${minutes} minutes` : `${minutes / 60} hour${minutes === 60 ? '' : 's'}`,
  })), String(settings.recordingStopAfter));
  $('blockTrackers').checked = settings.blockTrackers;
  $('checkForUpdates').checked = settings.checkForUpdates;
  fillSelect($('downloadsAtOnce'), settings.downloadsAtOnceChoices.map((count) => ({ key: String(count), label: String(count) })), String(settings.downloadsAtOnce));
  $('resumeDownloads').checked = settings.resumeDownloads;
  fillSelect($('connectionsPerFile'), settings.connectionsChoices.map((count) => ({ key: String(count), label: count === 1 ? '1 (never split)' : String(count) })), String(settings.connectionsPerFile));
  $('speedLimitNone').checked = settings.speedLimitKBps === 0;
  $('speedLimitOn').checked = settings.speedLimitKBps > 0;
  if (settings.speedLimitKBps > 0) $('speedLimitValue').value = String(Math.round((settings.speedLimitKBps / 1024) * 10) / 10);
  else if (!$('speedLimitValue').value) $('speedLimitValue').value = '5';
  $('markOfTheWeb').checked = settings.markOfTheWeb;
  showDownloadLimit(settings.speedLimitKBps);
  const sites = $('allowedSites');
  sites.replaceChildren();
  if (settings.blockerAllowedSites.length === 0) sites.append(element('p', 'empty', 'None.'));
  for (const site of settings.blockerAllowedSites) {
    const row = element('div', 'row');
    row.dataset.site = site;
    const main = element('div', 'main');
    main.append(element('div', 'name', site));
    const actions = element('div', 'actions');
    actions.append(button('Block again', async () => renderSettings(await api.blocker.removeSite(site))));
    row.append(main, actions);
    sites.append(row);
  }
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
  $('blockTrackers').addEventListener('change', () => saveSetting({ blockTrackers: $('blockTrackers').checked }));
  $('checkForUpdates').addEventListener('change', () => saveSetting({ checkForUpdates: $('checkForUpdates').checked }));
  $('downloadsAtOnce').addEventListener('change', () => saveSetting({ downloadsAtOnce: Number($('downloadsAtOnce').value) }));
  $('resumeDownloads').addEventListener('change', () => saveSetting({ resumeDownloads: $('resumeDownloads').checked }));
  $('connectionsPerFile').addEventListener('change', () => saveSetting({ connectionsPerFile: Number($('connectionsPerFile').value) }));
  // The limit is typed in MB/s and kept in KB/s.
  const saveLimit = () => {
    const megabytes = Number($('speedLimitValue').value);
    const kilobytes = Number.isFinite(megabytes) && megabytes > 0 ? Math.min(10 * 1024 * 1024, Math.max(1, Math.round(megabytes * 1024))) : 0;
    saveSetting({ speedLimitKBps: $('speedLimitOn').checked ? kilobytes : 0 });
  };
  $('speedLimitNone').addEventListener('change', saveLimit);
  $('speedLimitOn').addEventListener('change', saveLimit);
  $('speedLimitValue').addEventListener('change', () => {
    $('speedLimitOn').checked = true;
    saveLimit();
  });
  $('markOfTheWeb').addEventListener('change', () => saveSetting({ markOfTheWeb: $('markOfTheWeb').checked }));
  $('updatesCheck').addEventListener('click', async () => {
    $('updatesMessage').textContent = 'Checking…';
    const result = await api.updates.check();
    const messages = {
      'up-to-date': 'You have the latest version.',
      available: `Version ${result.version} is available: download it from the ⋮ menu.`,
      downloading: `Downloading version ${result.version}…`,
      ready: `Version ${result.version} is ready: restart from the ⋮ menu.`,
      error: 'Could not check for updates.',
    };
    $('updatesMessage').textContent = result.mode === 'off' ? 'Updates are not checked when running from source.' : messages[result.status] ?? '';
  });
  $('recordingQuality').addEventListener('change', () => saveSetting({ recordingQuality: $('recordingQuality').value }));
  $('recordingStopAfter').addEventListener('change', () => saveSetting({ recordingStopAfter: Number($('recordingStopAfter').value) }));
  $('recordingMicrophone').addEventListener('change', () => saveSetting({ recordingMicrophone: $('recordingMicrophone').checked }));
  $('showBookmarksBar').addEventListener('change', () => saveSetting({ showBookmarksBar: $('showBookmarksBar').checked }));
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
  bookmarks: () => { showBookmarksMessage(''); return loadBookmarks(); },
  downloads: loadDownloads,
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
$('playerClose').addEventListener('click', closePlayer);
$('trimStartSet').addEventListener('click', () => { trim.start = $('playerMedia').currentTime * 1000; if (trim.end <= trim.start) trim.end = $('playerMedia').duration * 1000; showTrim(); });
$('trimEndSet').addEventListener('click', () => { trim.end = $('playerMedia').currentTime * 1000; showTrim(); });
$('trimSave').addEventListener('click', saveTrim);
$('player').addEventListener('click', (event) => { if (event.target === $('player')) closePlayer(); });
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !$('player').hidden) closePlayer(); });
$('bookmarksImport').addEventListener('click', importBookmarks);
$('bookmarksExport').addEventListener('click', exportBookmarks);
$('bookmarksNewFolder').addEventListener('click', newBookmarkFolder);
$('bookmarksSearch').addEventListener('input', () => { selectedBookmarks.clear(); renderBookmarkPage(); });
$('bookmarksOpenAll').addEventListener('click', openAllBookmarks);
$('bookmarksMove').addEventListener('click', openMoveDialog);
$('bookmarksDelete').addEventListener('click', deleteSelectedBookmarks);
$('bookmarksClear').addEventListener('click', () => { selectedBookmarks.clear(); renderBookmarkPage(); });
bindSettings();
bindDownloads();

api.onLibraryShow(show);
api.onDownloads((items) => { if (current === 'downloads') renderDownloads(items); });
api.onRecordingsChanged(() => { if (current === 'recordings') loadRecordings(); });
api.onBookmarksChanged(() => { if (current === 'bookmarks') loadBookmarks(); });
api.onBookmarkReveal(revealBookmark);

show(location.hash.slice(1));
