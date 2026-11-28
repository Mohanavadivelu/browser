'use strict';

// A split tab's frame: drawn behind the two pages, in the space around them. Each side has a
// header (its site, and a ⋯ menu); the side in use is outlined; the bar between them is dragged
// (or moved with the arrow keys) to change their widths, and double-clicked to even them. In a
// narrow window only one side is shown, and its header switches to the other.
const api = window.browserApi;
const frame = document.getElementById('frame');
const SNAPS = [1 / 3, 1 / 2, 2 / 3];
const STEP = 0.05;

let geometry = null; // where things go, from the window
let sides = null; // { left, right }: each side's title, site, icon and privacy
let dragging = false;
let pending = null;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function place(node, { x, y, width, height }) {
  node.style.left = `${x}px`;
  node.style.top = `${y}px`;
  node.style.width = `${width}px`;
  node.style.height = `${height}px`;
}

const SIDE_NAME = { left: 'Left side', right: 'Right side' };

function dotsIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  for (const cx of [5, 12, 19]) {
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('cx', String(cx));
    dot.setAttribute('cy', '12');
    dot.setAttribute('r', '1.8');
    svg.append(dot);
  }
  return svg;
}

function icon(info) {
  if (info?.favicon?.startsWith('data:image/')) {
    const img = element('img', 'fav');
    img.src = info.favicon;
    img.alt = '';
    return img;
  }
  return element('span', `fav${info?.isPrivate ? ' private' : ''}`);
}

function siteLabel(info) {
  const label = element('span', 'site');
  label.append(info?.site || info?.title || 'New tab');
  if (info?.site && info.title) label.append(element('span', 'title', ` · ${info.title}`));
  return label;
}

function menuButton(side) {
  const button = element('button', 'menu');
  button.type = 'button';
  button.dataset.side = side;
  button.setAttribute('aria-label', `${SIDE_NAME[side]} menu`);
  button.title = `${SIDE_NAME[side]}: swap, even widths, own tab, close`;
  button.append(dotsIcon());
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    const box = button.getBoundingClientRect();
    api.split.menu(side, Math.round(box.left), Math.round(box.bottom));
  });
  return button;
}

function header(side) {
  const rect = geometry[side];
  const head = element('div', `head${geometry.focused === side ? ' on' : ''}`);
  head.dataset.side = side;
  const { header: height } = geometry.metrics;
  place(head, { x: rect.x, y: rect.y - height, width: rect.width, height });
  const info = sides?.[side];
  head.append(icon(info), siteLabel(info));
  if (info?.isPrivate) head.append(element('span', 'tag', 'Private'));
  head.append(menuButton(side));
  head.addEventListener('mousedown', () => { if (geometry.focused !== side) api.split.focus(side); });
  return head;
}

// A narrow window shows one side: its header names both, to switch.
function narrowHeader() {
  const side = geometry.focused;
  const rect = geometry[side];
  const head = element('div', 'head on');
  const { header: height } = geometry.metrics;
  place(head, { x: rect.x, y: rect.y - height, width: rect.width, height });
  for (const which of ['left', 'right']) {
    const pick = element('button', 'pick');
    pick.type = 'button';
    pick.dataset.side = which;
    pick.setAttribute('aria-pressed', String(which === side));
    pick.title = `Show the ${SIDE_NAME[which].toLowerCase()}`;
    pick.append(icon(sides?.[which]), siteLabel(sides?.[which]));
    pick.addEventListener('click', () => { if (which !== geometry.focused) api.split.focus(which); });
    head.append(pick);
  }
  head.append(menuButton(side));
  return head;
}

function ring(side) {
  const rect = geometry[side];
  const node = element('div', 'ring');
  const { header } = geometry.metrics;
  place(node, { x: rect.x - 2, y: rect.y - header - 2, width: rect.width + 4, height: rect.height + header + 4 });
  return node;
}

const percent = (ratio) => Math.round(ratio * 100);

function divider() {
  const bar = element('div', 'divider');
  bar.id = 'divider';
  place(bar, geometry.divider);
  bar.tabIndex = 0;
  bar.setAttribute('role', 'separator');
  bar.setAttribute('aria-orientation', 'vertical');
  bar.setAttribute('aria-label', 'Width of the two sides (arrow keys to change, Enter to even them)');
  bar.setAttribute('aria-valuemin', '25');
  bar.setAttribute('aria-valuemax', '75');
  bar.setAttribute('aria-valuenow', String(percent(geometry.ratio)));
  bar.setAttribute('aria-valuetext', `${percent(geometry.ratio)} : ${100 - percent(geometry.ratio)}`);
  bar.append(element('span', 'grip'));
  bar.addEventListener('pointerdown', startDrag);
  bar.addEventListener('dblclick', () => api.split.even());
  bar.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      api.split.ratio(geometry.ratio + (event.key === 'ArrowLeft' ? -STEP : STEP));
    } else if (event.key === 'Enter' || event.key === 'Home') {
      event.preventDefault();
      api.split.even();
    }
  });
  return bar;
}

function draw() {
  if (!geometry) {
    frame.replaceChildren();
    return;
  }
  const focusBar = document.activeElement?.id === 'divider';
  const parts = [];
  if (geometry.narrow) {
    parts.push(narrowHeader());
  } else {
    parts.push(ring(geometry.focused), header('left'), header('right'), divider());
    if (dragging) {
      const middle = geometry.divider.x + geometry.divider.width / 2;
      const readout = element('div', 'readout', `${percent(geometry.ratio)} : ${100 - percent(geometry.ratio)}`);
      readout.style.left = `${middle}px`;
      readout.style.top = `${geometry.divider.y + geometry.divider.height / 2}px`;
      const { margin, gap } = geometry.metrics;
      const inner = geometry.width - 2 * margin - gap;
      for (const snap of SNAPS) {
        const mark = element('div', 'snap');
        mark.style.left = `${margin + gap / 2 + inner * snap - 1}px`;
        mark.style.top = `${geometry.divider.y}px`;
        parts.push(mark);
      }
      parts.push(readout);
    }
  }
  frame.replaceChildren(...parts);
  if (focusBar) document.getElementById('divider')?.focus();
}

// ---------- Dragging the bar ----------
function ratioAt(clientX) {
  const { margin, gap } = geometry.metrics;
  const inner = geometry.width - 2 * margin - gap;
  return inner > 0 ? (clientX - margin - gap / 2) / inner : 0.5;
}

function startDrag(event) {
  if (event.button !== 0 || !geometry || geometry.narrow) return;
  event.preventDefault();
  dragging = true;
  document.body.classList.add('dragging');
  api.split.drag(true);
  draw();
}

// The view lies over the whole page area while dragging, so the moves come here wherever the
// pointer goes; one width a frame is sent.
document.addEventListener('pointermove', (event) => {
  if (!dragging) return;
  const first = pending === null;
  pending = ratioAt(event.clientX);
  if (first) {
    requestAnimationFrame(() => {
      if (pending !== null) api.split.ratio(pending);
      pending = null;
    });
  }
});

function endDrag() {
  if (!dragging) return;
  dragging = false;
  document.body.classList.remove('dragging');
  api.split.drag(false);
  draw();
}
document.addEventListener('pointerup', endDrag);
document.addEventListener('pointercancel', endDrag);
window.addEventListener('blur', endDrag);

api.onSplitLayout((next) => {
  geometry = next;
  draw();
});
api.onSplitState((next) => {
  sides = next;
  draw();
});
api.split.state().then((initial) => {
  if (!initial) return;
  geometry = initial.geometry ?? geometry;
  sides = initial.sides ?? sides;
  draw();
});
