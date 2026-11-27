'use strict';

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
