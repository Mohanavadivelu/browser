'use strict';

// Wires the library pages together: which page shows, the buttons whose handlers live in the
// pages' own scripts (loaded before this one, see library.html), and what the main process
// tells the pages.

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
bindClearData();

api.onLibraryShow(show);
api.onDownloads((items) => { if (current === 'downloads') renderDownloads(items); });
api.onHistoryChanged(() => { if (current === 'history') loadHistory(); });
api.onRecordingsChanged(() => { if (current === 'recordings') loadRecordings(); });
api.onBookmarksChanged(() => { if (current === 'bookmarks') loadBookmarks(); });
api.onBookmarkReveal(revealBookmark);

show(location.hash.slice(1));
