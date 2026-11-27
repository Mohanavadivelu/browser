'use strict';

// The tab strip: drawing the tabs and dragging them to a new place.

// The tab being dragged to a new place; the strip is not rebuilt while a drag is under way.
const TAB_DRAG_TYPE = 'application/x-simple-browser-tab';
let draggingTab = null;

function renderTabs() {
  if (draggingTab !== null) return;
  const strip = $('tabs');
  strip.replaceChildren();
  for (const tab of state.tabs) {
    const node = element('div', `tab${tab.id === state.activeId ? ' active' : ''}${tab.isPrivate ? ' private' : ''}`);
    node.dataset.id = String(tab.id);
    node.draggable = true;
    if (tab.crashed) {
      // The page in this tab crashed: a warning mark instead of the site's icon.
      const mark = document.createElementNS(SVG, 'svg');
      mark.setAttribute('viewBox', '0 0 24 24');
      mark.setAttribute('class', 'fav crashed');
      mark.setAttribute('aria-hidden', 'true');
      for (const d of ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M12 7.5v5.5', 'M12 16.5v.01']) {
        const path = document.createElementNS(SVG, 'path');
        path.setAttribute('d', d);
        mark.append(path);
      }
      node.append(mark);
    } else if (tab.favicon) {
      const icon = element('img', 'fav');
      icon.src = tab.favicon;
      icon.alt = '';
      icon.draggable = false;
      node.append(icon);
    } else {
      node.append(element('span', 'fav'));
    }
    node.append(element('span', 'title', tab.title));
    if (tab.isPrivate) node.append(element('span', 'private-tag', 'Private'));
    if (tab.audible || tab.muted) {
      const sound = element('button', 'sound', tab.muted ? '🔇' : '🔊');
      sound.title = tab.muted ? 'Unmute this tab' : 'Mute this tab';
      sound.addEventListener('click', (event) => { event.stopPropagation(); api.tabs.toggleMute(tab.id); });
      node.append(sound);
    }
    const close = element('button', 'close', '✕');
    close.title = 'Close tab';
    close.addEventListener('click', (event) => { event.stopPropagation(); api.tabs.close(tab.id); });
    node.append(close);
    node.addEventListener('click', () => api.tabs.activate(tab.id));
    node.addEventListener('auxclick', (event) => { if (event.button === 1) api.tabs.close(tab.id); });
    node.addEventListener('dragstart', (event) => {
      draggingTab = tab.id;
      event.dataTransfer.setData(TAB_DRAG_TYPE, String(tab.id));
      event.dataTransfer.effectAllowed = 'move';
      node.classList.add('dragging');
    });
    node.addEventListener('dragend', endTabDrag);
    strip.append(node);
  }
}

// Where a dropped tab goes: before the first other tab whose middle is right of the pointer.
function dropIndex(clientX) {
  const others = [...$('tabs').children].filter((node) => Number(node.dataset.id) !== draggingTab);
  const index = others.findIndex((node) => {
    const box = node.getBoundingClientRect();
    return clientX < box.left + box.width / 2;
  });
  return { others, index: index === -1 ? others.length : index };
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
  const { index } = dropIndex(event.clientX);
  if (id === draggingTab) api.tabs.move(id, index);
  endTabDrag();
});
