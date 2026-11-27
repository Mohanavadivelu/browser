'use strict';

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

// ---------- Acting on the selection, import and export ----------
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
