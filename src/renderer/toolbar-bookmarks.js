'use strict';

// The bookmarks bar: its buttons and site icons, the » overflow, the folder and right-click
// menus (menu.js), and dragging bookmarks along it.

// Site icons of the bar's bookmarks, fetched from the main process only when they change.
let barIcons = {};
let barIconsKey = '';
async function refreshBarIcons() {
  const urls = state.bookmarks.filter((item) => item.icon).map((item) => item.url);
  const key = `${state.bookmarkIconsVersion}|${urls.join(' ')}`;
  if (key === barIconsKey) return;
  barIconsKey = key;
  barIcons = urls.length ? await api.bookmarks.icons(urls) : {};
  renderBookmarks();
}

// ---------- Bookmark menus ----------
// Folders, » and right-click open dark menus (menu.js) drawn in the toolbar's view, which grows
// over the page while one is open. Bookmarks are named by id; the main process opens them.
async function menuOptions() {
  const windowHeight = await requestOverlay('menu', 0);
  return {
    maxBottom: windowHeight || window.screen.availHeight,
    onLayout: (bottom) => requestOverlay('menu', bottom ? bottom + 8 - chromeHeight() : 0),
  };
}

const glyph = (text) => element('span', 'bm-star', text);
const linkMenuItem = (node, icon) => ({
  label: node.title, title: node.url, icon: icon || glyph('★'), onSelect: () => api.bookmarks.action(node.id, 'open'),
});
const folderMenuItem = (node) => ({
  label: node.title, icon: folderIcon(false), submenu: async () => folderMenuItems(await api.bookmarks.folder(node.id)),
});

// A folder's menu: its bookmarks and folders (as submenus), then "Open all".
function folderMenuItems(folder) {
  if (!folder) return null;
  const items = folder.children.map((node) => (node.type === 'folder' ? folderMenuItem(node) : linkMenuItem(node, node.icon)));
  if (items.length === 0) items.push({ label: '(empty)', disabled: true });
  if (folder.count > 0) {
    items.push({ separator: true }, { label: `Open all (${folder.count}) in new tabs`, onSelect: () => api.bookmarks.action(folder.id, 'open-all') });
  }
  return items;
}

async function contextMenuItems(item) {
  const run = (action) => () => api.bookmarks.action(item.id, action);
  if (item.type === 'link') {
    return [
      { label: 'Open', onSelect: run('open') },
      { label: 'Open in new tab', onSelect: run('tab') },
      { label: 'Open in private tab', onSelect: run('private') },
      { label: 'Copy address', onSelect: run('copy') },
      { separator: true },
      { label: 'Edit…', onSelect: run('edit') },
      { label: 'Delete', onSelect: run('delete'), danger: true },
    ];
  }
  const folder = await api.bookmarks.folder(item.id);
  if (!folder) return null;
  const items = [{ label: `Open all (${folder.count}) in new tabs`, disabled: folder.count === 0, onSelect: run('open-all') }];
  // Bookmarks bar and Other bookmarks can be opened, not renamed or deleted.
  if (item.id !== 'bar' && item.id !== 'other') {
    items.push({ separator: true }, { label: 'Rename…', onSelect: run('edit') }, { label: 'Delete', onSelect: run('delete'), danger: true });
  }
  return items;
}

function openMenuBelow(chip, getItems) {
  DarkMenu.toggle(chip, getItems, async () => {
    const box = chip.getBoundingClientRect();
    return { ...(await menuOptions()), x: Math.round(box.left), y: Math.round(box.bottom + 2) };
  });
}

async function openContextMenu(item, x, y) {
  const [items, options] = await Promise.all([contextMenuItems(item), menuOptions()]);
  if (items) DarkMenu.open(items, { ...options, x, y });
}

// ---------- Dragging bookmarks on the bar ----------
// Drop before or after a bookmark, or on the middle of a folder (or on Other bookmarks) to put it
// in there. The index counts the bar's items as they are once the dragged one is taken out.
const BAR_DRAG_TYPE = 'application/x-simple-browser-bookmark';
let barDragId = null;

function clearBarDropMarks() {
  document.querySelectorAll('#bookmarks .drop-before, #bookmarks .drop-after, #bookmarks .drop-into')
    .forEach((node) => node.classList.remove('drop-before', 'drop-after', 'drop-into'));
}

function barDropPlace(chip, item, event) {
  if (!barDragId || barDragId === item.id) return null;
  if (item.id === 'other') return { parentId: 'other', index: 10000, mark: 'drop-into' };
  const box = chip.getBoundingClientRect();
  const at = (event.clientX - box.left) / box.width;
  if (item.type === 'folder' && at > 0.25 && at < 0.75) return { parentId: item.id, index: 10000, mark: 'drop-into' };
  const index = state.bookmarks.findIndex((bookmark) => bookmark.id === item.id);
  const from = state.bookmarks.findIndex((bookmark) => bookmark.id === barDragId);
  const before = at <= 0.5;
  const target = index + (before ? 0 : 1) - (from !== -1 && from < index + (before ? 0 : 1) ? 1 : 0);
  return { parentId: 'bar', index: target, mark: before ? 'drop-before' : 'drop-after' };
}

function wireBarDrag(chip, item) {
  if (item.id !== 'other') {
    chip.draggable = true;
    chip.addEventListener('dragstart', (event) => {
      DarkMenu.close();
      barDragId = item.id;
      event.dataTransfer.setData(BAR_DRAG_TYPE, item.id);
      event.dataTransfer.effectAllowed = 'move';
      chip.classList.add('dragging');
    });
    chip.addEventListener('dragend', () => {
      barDragId = null;
      chip.classList.remove('dragging');
      clearBarDropMarks();
    });
  }
  chip.addEventListener('dragover', (event) => {
    if (!event.dataTransfer.types.includes(BAR_DRAG_TYPE)) return;
    const place = barDropPlace(chip, item, event);
    clearBarDropMarks();
    if (!place) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    chip.classList.add(place.mark);
  });
  chip.addEventListener('dragleave', () => chip.classList.remove('drop-before', 'drop-after', 'drop-into'));
  chip.addEventListener('drop', (event) => {
    const place = barDropPlace(chip, item, event);
    const id = barDragId;
    clearBarDropMarks();
    if (!place || !id) return;
    event.preventDefault();
    api.bookmarks.move(id, place.parentId, place.index);
  });
}

function bookmarkChip(item) {
  const chip = element('button', `chip${item.type === 'folder' ? ' folder' : ''}`);
  chip.type = 'button';
  chip.dataset.id = item.id;
  if (item.type === 'folder') {
    // A folder opens as a menu just under its button.
    chip.append(folderIcon(item.id === 'other'), element('span', 'label', item.title), element('span', 'caret', '▾'));
    chip.title = `${item.title} (folder)`;
    chip.setAttribute('aria-haspopup', 'menu');
    chip.addEventListener('click', () => openMenuBelow(chip, async () => folderMenuItems(await api.bookmarks.folder(item.id))));
  } else {
    if (barIcons[item.url]) {
      const icon = element('img', 'bm-icon');
      icon.src = barIcons[item.url];
      icon.alt = '';
      chip.append(icon);
    } else {
      chip.append(element('span', 'bm-star', '★'));
    }
    chip.append(element('span', 'label', item.title));
    chip.title = `${item.title}\n${item.url}`;
    chip.addEventListener('click', () => api.nav.go(item.url));
  }
  // Right-click: open in a new or private tab, copy the address, edit, delete.
  chip.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    openContextMenu(item, Math.round(event.clientX), Math.round(event.clientY));
  });
  wireBarDrag(chip, item);
  return chip;
}

function renderBookmarks() {
  const bar = $('bookmarks');
  bar.replaceChildren();
  if (state.bookmarks.length === 0 && !state.otherBookmarks) {
    bar.append(element('span', 'hint', 'Press ☆ in the address bar to bookmark a page.'));
    return;
  }
  const chips = state.bookmarks.map(bookmarkChip);
  const more = element('button', 'chip more', '»');
  more.type = 'button';
  more.title = 'More bookmarks';
  more.setAttribute('aria-label', 'More bookmarks');
  more.hidden = true;
  bar.append(...chips, element('span', 'spacer'), more);
  let other = null;
  if (state.otherBookmarks) {
    other = bookmarkChip({ id: 'other', type: 'folder', title: 'Other bookmarks' });
    other.classList.add('other');
    bar.append(other);
  }
  // Bookmarks that would run past the bar's visible width, less room for » and Other bookmarks,
  // go into the » menu instead.
  more.hidden = false;
  const reserved = more.offsetWidth + 6 + (other ? other.offsetWidth + 6 : 0);
  more.hidden = true;
  const padding = parseFloat(getComputedStyle(bar).paddingRight) || 0;
  const limit = bar.clientWidth - padding - reserved;
  const hidden = [];
  chips.forEach((chip, i) => {
    if (hidden.length || chip.offsetLeft + chip.offsetWidth > limit) {
      chip.hidden = true;
      hidden.push(state.bookmarks[i].id);
    }
  });
  if (hidden.length) {
    more.hidden = false;
    more.title = `${hidden.length} more bookmark${hidden.length === 1 ? '' : 's'}`;
    more.addEventListener('click', () => openMenuBelow(more, () => state.bookmarks
      .filter((item) => hidden.includes(item.id))
      .map((item) => (item.type === 'folder' ? folderMenuItem(item) : linkMenuItem(item, barIcons[item.url])))));
  }
}

window.addEventListener('resize', () => { if (state) renderBookmarks(); });
