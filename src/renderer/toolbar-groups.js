'use strict';

// ---------- A tab group's name and colour ----------
// A small panel under the group's chip: type a name (Enter or leaving the box saves it) and pick
// one of the colours (saved at once). Esc or a click elsewhere closes it.
const GROUP_COLOR_NAMES = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan'];
let editingGroup = null;

function drawGroupEditor() {
  const group = groupById(editingGroup);
  const panel = $('groupPanel');
  if (!group) {
    closeGroupEditor();
    return;
  }
  if (document.activeElement !== $('groupName')) $('groupName').value = group.name;
  const swatches = $('groupColors');
  swatches.replaceChildren(...GROUP_COLOR_NAMES.map((color) => {
    const swatch = element('button', `group-swatch group-${color}`);
    swatch.type = 'button';
    swatch.setAttribute('role', 'radio');
    swatch.setAttribute('aria-checked', String(color === group.color));
    swatch.setAttribute('aria-label', color[0].toUpperCase() + color.slice(1));
    swatch.title = swatch.getAttribute('aria-label');
    swatch.addEventListener('click', () => api.tabs.updateGroup(group.id, { color }));
    return swatch;
  }));
  const chip = document.querySelector(`.group-chip[data-group="${group.id}"]`);
  const anchor = chip?.getBoundingClientRect() ?? { left: 8, bottom: chromeHeight() - 40 };
  panel.style.top = `${Math.round(anchor.bottom + 8)}px`;
  panel.style.left = `${Math.max(8, Math.min(Math.round(anchor.left), window.innerWidth - panel.offsetWidth - 8))}px`;
  requestOverlay('group', panel.getBoundingClientRect().bottom + 12 - chromeHeight());
}

function openGroupEditor(groupId) {
  if (!groupById(groupId)) return;
  editingGroup = groupId;
  $('groupPanel').hidden = false;
  $('groupName').value = groupById(groupId).name;
  drawGroupEditor();
  $('groupName').focus();
  $('groupName').select();
}

function closeGroupEditor() {
  if (!editingGroup) return;
  editingGroup = null;
  $('groupPanel').hidden = true;
  requestOverlay('group', 0);
}

function saveGroupName() {
  if (editingGroup) api.tabs.updateGroup(editingGroup, { name: $('groupName').value });
}

// Called with every state from the main process while the panel is open.
function followGroupEditor() {
  if (editingGroup) drawGroupEditor();
}

$('groupName').addEventListener('change', saveGroupName);
$('groupName').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    saveGroupName();
    closeGroupEditor();
  }
});
$('groupDone').addEventListener('click', () => {
  saveGroupName();
  closeGroupEditor();
});
$('groupPanel').addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  closeGroupEditor();
});
document.addEventListener('mousedown', (event) => {
  if (editingGroup && !$('groupPanel').contains(event.target)) {
    saveGroupName();
    closeGroupEditor();
  }
});
