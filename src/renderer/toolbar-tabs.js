'use strict';

// The tab strip: drawing the tabs (pinned ones small, at the start; sleeping ones dimmed; tab
// groups behind a coloured chip that folds them away), dragging them to a new place, and the
// right-click menus of tabs and group chips.

// The tab being dragged to a new place; the strip is not rebuilt while a drag is under way.
const TAB_DRAG_TYPE = 'application/x-simple-browser-tab';
let draggingTab = null;

const groupById = (id) => state.groups?.find((group) => group.id === id) ?? null;
const groupLabel = (group) => group.name || `${group.count} tab${group.count === 1 ? '' : 's'}`;

function crashMark() {
  const mark = document.createElementNS(SVG, 'svg');
  mark.setAttribute('viewBox', '0 0 24 24');
  mark.setAttribute('class', 'fav crashed');
  mark.setAttribute('aria-hidden', 'true');
  for (const d of ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M12 7.5v5.5', 'M12 16.5v.01']) {
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', d);
    mark.append(path);
  }
  return mark;
}

function tabNode(tab) {
  const group = tab.groupId ? groupById(tab.groupId) : null;
  const classes = ['tab'];
  if (tab.id === state.activeId) classes.push('active');
  if (tab.isPrivate) classes.push('private');
  if (tab.pinned) classes.push('pinned');
  if (tab.sleeping) classes.push('sleeping');
  if (group) classes.push('grouped', `group-${group.color}`);
  const node = element('div', classes.join(' '));
  node.dataset.id = String(tab.id);
  node.draggable = true;
  if (tab.crashed) {
    // The page in this tab crashed: a warning mark instead of the site's icon.
    node.append(crashMark());
  } else if (tab.favicon) {
    const icon = element('img', 'fav');
    icon.src = tab.favicon;
    icon.alt = '';
    icon.draggable = false;
    node.append(icon);
  } else {
    node.append(element('span', 'fav'));
  }
  const notes = [];
  if (tab.pinned) notes.push('pinned');
  if (tab.sleeping) notes.push('asleep to save memory: it wakes when you open it');
  node.title = notes.length ? `${tab.title} (${notes.join('; ')})` : tab.title;
  if (!tab.pinned) node.append(element('span', 'title', tab.title));
  else node.setAttribute('aria-label', node.title);
  if (tab.isPrivate) node.append(element('span', 'private-tag', 'Private'));
  if (tab.audible || tab.muted) {
    const sound = element('button', 'sound', tab.muted ? '🔇' : '🔊');
    sound.title = tab.muted ? 'Unmute this tab' : 'Mute this tab';
    sound.addEventListener('click', (event) => { event.stopPropagation(); api.tabs.toggleMute(tab.id); });
    node.append(sound);
  }
  // A pinned tab has no ×, so it isn't closed by accident; its menu closes it.
  if (!tab.pinned) {
    const close = element('button', 'close', '✕');
    close.title = 'Close tab';
    close.addEventListener('click', (event) => { event.stopPropagation(); api.tabs.close(tab.id); });
    node.append(close);
  }
  node.addEventListener('click', () => api.tabs.activate(tab.id));
  node.addEventListener('auxclick', (event) => { if (event.button === 1 && !tab.pinned) api.tabs.close(tab.id); });
  node.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    openTabMenu(tab, event.clientX, event.clientY);
  });
  node.addEventListener('dragstart', (event) => {
    draggingTab = tab.id;
    event.dataTransfer.setData(TAB_DRAG_TYPE, String(tab.id));
    event.dataTransfer.effectAllowed = 'move';
    node.classList.add('dragging');
  });
  node.addEventListener('dragend', endTabDrag);
  return node;
}

function groupChip(group) {
  const chip = element('button', `group-chip group-${group.color}${group.collapsed ? ' collapsed' : ''}`);
  chip.type = 'button';
  chip.dataset.group = group.id;
  chip.append(element('span', 'group-dot'), element('span', 'group-name', groupLabel(group)));
  if (group.collapsed) chip.append(element('span', 'group-count', String(group.count)));
  chip.setAttribute('aria-expanded', String(!group.collapsed));
  chip.title = `${group.name ? `${group.name}: ` : ''}${group.count} tab${group.count === 1 ? '' : 's'}. Click to ${group.collapsed ? 'show' : 'fold away'}; right-click for more.`;
  chip.addEventListener('click', () => api.tabs.updateGroup(group.id, { collapsed: !group.collapsed }));
  chip.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    openGroupMenu(group, event.clientX, event.clientY);
  });
  // A tab dropped on the chip joins the group.
  chip.addEventListener('dragover', (event) => {
    if (draggingTab === null) return;
    event.preventDefault();
    event.stopPropagation();
    chip.classList.add('drop-into');
  });
  chip.addEventListener('dragleave', () => chip.classList.remove('drop-into'));
  chip.addEventListener('drop', (event) => {
    if (draggingTab === null) return;
    event.preventDefault();
    event.stopPropagation();
    api.tabs.addToGroup(draggingTab, group.id);
    endTabDrag();
  });
  return chip;
}

function renderTabs() {
  if (draggingTab !== null) return;
  const strip = $('tabs');
  const parts = [];
  let previousGroup = null;
  for (const tab of state.tabs) {
    const group = tab.groupId ? groupById(tab.groupId) : null;
    if (group && group.id !== previousGroup) parts.push(groupChip(group));
    previousGroup = group?.id ?? null;
    if (group?.collapsed) continue;
    parts.push(tabNode(tab));
  }
  strip.replaceChildren(...parts);
}

// ---------- Menus ----------
async function openTabMenu(tab, x, y) {
  const items = [];
  const web = tab.kind === 'web';
  if (web && !tab.isPrivate) items.push({ label: tab.pinned ? 'Unpin tab' : 'Pin tab', onSelect: () => api.tabs.pin(tab.id, !tab.pinned) });
  if (web && !tab.pinned) {
    items.push({ separator: true }, { label: 'Add to a new group', onSelect: () => newGroupFor(tab.id) });
    const others = (state.groups ?? []).filter((group) => group.id !== tab.groupId);
    if (others.length) {
      items.push({
        label: 'Add to group',
        submenu: () => others.map((group) => ({ label: groupLabel(group), icon: element('span', `group-dot group-${group.color}`), onSelect: () => api.tabs.addToGroup(tab.id, group.id) })),
      });
    }
    if (tab.groupId) items.push({ label: 'Remove from group', onSelect: () => api.tabs.removeFromGroup(tab.id) });
  }
  if (web && !tab.pinned && !tab.sleeping && tab.id !== state.activeId) {
    items.push({ separator: true }, { label: 'Put to sleep now', onSelect: () => api.tabs.sleep(tab.id) });
  }
  items.push({ separator: true }, { label: 'Close tab', onSelect: () => api.tabs.close(tab.id) });
  DarkMenu.open(items, { ...(await menuOptions()), x, y });
}

async function openGroupMenu(group, x, y) {
  const items = [
    { label: 'Name and colour…', onSelect: () => openGroupEditor(group.id) },
    { label: group.collapsed ? 'Show its tabs' : 'Fold away', onSelect: () => api.tabs.updateGroup(group.id, { collapsed: !group.collapsed }) },
    { separator: true },
    { label: 'Ungroup', onSelect: () => api.tabs.ungroup(group.id) },
    { label: `Close the group's ${group.count} tab${group.count === 1 ? '' : 's'}`, danger: true, onSelect: () => api.tabs.closeGroup(group.id) },
  ];
  DarkMenu.open(items, { ...(await menuOptions()), x, y });
}

// A new group opens its name and colour panel as soon as the toolbar knows of it.
async function newGroupFor(tabId) {
  const groupId = await api.tabs.newGroup(tabId);
  for (let tries = 0; groupId && tries < 20; tries += 1) {
    if (groupById(groupId)) {
      openGroupEditor(groupId);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// ---------- Dragging ----------
// Where a dropped tab goes: before the first other tab shown whose middle is right of the
// pointer, as a place among all the tabs (folded-away ones included).
function dropIndex(clientX) {
  const others = [...$('tabs').querySelectorAll('.tab')].filter((node) => Number(node.dataset.id) !== draggingTab);
  const at = others.findIndex((node) => {
    const box = node.getBoundingClientRect();
    return clientX < box.left + box.width / 2;
  });
  const index = at === -1 ? others.length : at;
  const order = state.tabs.map((tab) => tab.id).filter((id) => id !== draggingTab);
  const target = others[index] ? Number(others[index].dataset.id) : null;
  return { others, index, place: target === null ? order.length : order.indexOf(target) };
}

function markDropPlace(clientX) {
  const { others, index } = dropIndex(clientX);
  others.forEach((node, i) => {
    node.classList.toggle('drop-before', i === index);
    node.classList.toggle('drop-after', index === others.length && i === others.length - 1);
  });
}

function endTabDrag() {
  draggingTab = null;
  if (state) renderTabs();
}

$('tabs').addEventListener('dragover', (event) => {
  if (draggingTab === null || !event.dataTransfer.types.includes(TAB_DRAG_TYPE)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  markDropPlace(event.clientX);
});
$('tabs').addEventListener('drop', (event) => {
  if (draggingTab === null) return;
  event.preventDefault();
  const id = Number(event.dataTransfer.getData(TAB_DRAG_TYPE));
  const { place } = dropIndex(event.clientX);
  if (id === draggingTab) api.tabs.move(id, place);
  endTabDrag();
});
