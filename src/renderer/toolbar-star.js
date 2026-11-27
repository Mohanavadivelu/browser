'use strict';

// ---------- The star's popover ----------
// ☆ or Ctrl+D bookmarks the page (into the folder used last) and opens this; ★ opens it to edit.
// Done, Enter or a click elsewhere saves; Esc closes without saving changes; Remove deletes.
let starBookmark = null;
const NEW_FOLDER = '__new__';

async function openStar() {
  if (starBookmark) {
    await closeStar(true);
    return;
  }
  closeShield();
  closeDownloads();
  closeVideos();
  closeSite();
  closeTabSearch();
  const info = await api.bookmarks.star();
  if (!info) return;
  starBookmark = info;
  $('starTitle').textContent = info.added ? 'Bookmark added' : 'Edit bookmark';
  $('starName').value = info.title;
  const folders = $('starFolder');
  folders.replaceChildren(...info.folders.map(({ id, label }) => {
    const option = element('option', undefined, label);
    option.value = id;
    return option;
  }), Object.assign(element('option', undefined, 'New folder…'), { value: NEW_FOLDER }));
  folders.value = info.folderId;
  $('starNewFolderField').hidden = true;
  const popover = $('starPopover');
  popover.hidden = false;
  // Right edge under the star, never off the window's left edge.
  const star = $('star').getBoundingClientRect();
  popover.style.top = `${Math.round(star.bottom + 10)}px`;
  popover.style.left = `${Math.max(8, Math.round(star.right + 12 - popover.offsetWidth))}px`;
  requestOverlay('star', popover.getBoundingClientRect().bottom + 12 - chromeHeight());
  $('starName').focus();
  $('starName').select();
}

async function closeStar(save) {
  const bookmark = starBookmark;
  if (!bookmark) return;
  starBookmark = null;
  $('starPopover').hidden = true;
  requestOverlay('star', 0);
  if (!save) return;
  const patch = { title: $('starName').value };
  if ($('starFolder').value === NEW_FOLDER) patch.newFolder = $('starNewFolder').value;
  else patch.folderId = $('starFolder').value;
  await api.bookmarks.starSave(bookmark.id, patch);
}

$('starFolder').addEventListener('change', () => {
  const making = $('starFolder').value === NEW_FOLDER;
  $('starNewFolderField').hidden = !making;
  requestOverlay('star', $('starPopover').getBoundingClientRect().bottom + 12 - chromeHeight());
  if (making) {
    $('starNewFolder').focus();
    $('starNewFolder').select();
  }
});
$('starDone').addEventListener('click', () => closeStar(true));
$('starRemove').addEventListener('click', async () => {
  const bookmark = starBookmark;
  await closeStar(false);
  if (bookmark) api.bookmarks.starRemove(bookmark.id);
});
$('starPopover').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && event.target.tagName === 'INPUT') {
    event.preventDefault();
    closeStar(true);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    closeStar(false);
  }
});
// A click anywhere else in the bars saves and closes it.
document.addEventListener('mousedown', (event) => {
  if (starBookmark && !$('starPopover').contains(event.target) && event.target !== $('star')) closeStar(true);
});
