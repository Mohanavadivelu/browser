'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { validators } = require('./security/ipc-validate');
const { isAllowedUrl, SEARCH_ENGINES } = require('./security/navigation');
const { pickEditable } = require('./storage/settings');
const { publicQualities } = require('./recording/quality');
const { suggest } = require('./suggestions');
const { mediaUrl } = require('./recording/media-server');
const bookmarkList = require('./bookmarks');
const { MAX_BOOKMARKS } = require('./storage/settings');
const { hostOf } = require('./blocker');

const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
const {
  isSafeName, listRecordings, renameRecording, deleteRecording,
} = require('./recording/library');

// Which of the browser's own pages may call each channel (see ROLES in security/ipc-validate.js).
// The library tab shows titles and addresses that come from websites, so it gets no recording,
// navigation or tab controls; the toolbar gets no access to files, settings or history.
const TOOLBAR = ['toolbar'];
const INDICATOR = ['indicator'];
const BAR_AND_REC = ['toolbar', 'indicator'];
const FIND = ['find'];
const LIBRARY = ['library'];

// Every call from the browser's own pages comes through here. The sender, its page and the
// arguments are checked by `ipc.handle` before any handler runs.
function registerIpcHandlers(ipc, ctx) {
  const {
    app, shell, dialog, host, tabs, recorder, settings, history, downloads, recordingsIndex, refreshBlockerLists, updates,
    ui, find, actions, notify, pushState, buildState, getRecordingFolder, broadcastToLibrary, showMenu,
  } = ctx;
  const {
    none, tabId, tabMove, text, optionalText, twoTexts, textAndIndex, bool, pixels, settingsPatch, findQuery, tabOptions, chunk,
  } = validators;

  const settingsPayload = () => ({
    ...pickEditable(settings.data),
    blockerAllowedSites: settings.data.blockerAllowedSites,
    recordingFolder: getRecordingFolder(),
    engines: Object.entries(SEARCH_ENGINES).map(([key, engine]) => ({ key, name: engine.name })),
    qualities: publicQualities(),
  });

  // Tabs and navigation
  ipc.handle('ui:get-state', BAR_AND_REC, none, () => buildState());
  ipc.handle('tabs:create', TOOLBAR, tabOptions, (_e, opts = {}) => { tabs.create({ isPrivate: opts.private === true }); });
  ipc.handle('tabs:close', TOOLBAR, tabId, (_e, id) => tabs.close(id));
  ipc.handle('tabs:activate', TOOLBAR, tabId, (_e, id) => tabs.activate(id));
  ipc.handle('tabs:open', LIBRARY, text, (_e, url) => { if (isAllowedUrl(url)) tabs.create({ url }); });
  ipc.handle('tabs:move', TOOLBAR, tabMove, (_e, id, index) => tabs.move(id, index));
  ipc.handle('tabs:toggle-mute', TOOLBAR, tabId, (_e, id) => tabs.toggleMute(id));
  ipc.handle('nav:go', TOOLBAR, text, (_e, input) => tabs.navigate(input).ok);
  ipc.handle('nav:back', TOOLBAR, none, () => tabs.back());
  ipc.handle('nav:forward', TOOLBAR, none, () => tabs.forward());
  ipc.handle('nav:reload', TOOLBAR, none, () => tabs.reload());
  ipc.handle('nav:stop', TOOLBAR, none, () => tabs.stop());
  ipc.handle('nav:home', TOOLBAR, none, () => tabs.goHome());
  ipc.handle('window:toggle-fullscreen', TOOLBAR, none, () => host.toggleFullscreen());
  ipc.handle('window:reveal', TOOLBAR, bool, (_e, revealed) => host.setRevealed(revealed));
  ipc.handle('window:menu', TOOLBAR, none, () => showMenu());
  ipc.handle('bookmarks:toggle', TOOLBAR, none, () => actions.toggleBookmark());
  ipc.handle('zoom:reset', TOOLBAR, none, () => actions.zoom(0));

  // Address-bar suggestions: visited pages only while history is on.
  ipc.handle('suggest:query', TOOLBAR, text, (_e, input) => suggest({
    text: input,
    history: settings.data.historyEnabled ? history.entries : [],
    bookmarks: settings.data.bookmarks,
    engine: settings.data.searchEngine,
  }));
  // The suggestion list needs the toolbar's view to reach below the browser bars while open.
  ipc.handle('window:suggestions', TOOLBAR, pixels, (_e, height) => host.setSuggestionsHeight(height));

  // Find in page
  ipc.handle('find:query', FIND, findQuery, (_e, query, options) => {
    const contents = tabs.active?.view.webContents;
    if (!contents) return;
    if (!query) {
      contents.stopFindInPage('clearSelection');
      find.webContents.send('find:result', { active: 0, matches: 0 });
      return;
    }
    contents.findInPage(query, { forward: options.forward !== false, findNext: options.next === true, matchCase: false });
  });
  ipc.handle('find:close', FIND, none, () => host.closeFind());

  // Settings
  ipc.handle('settings:get', LIBRARY, none, () => settingsPayload());
  ipc.handle('settings:update', LIBRARY, settingsPatch, (_e, patch) => {
    settings.update(pickEditable(patch));
    if (patch.blockTrackers === true) refreshBlockerLists?.();
    if (!settings.data.restoreTabs) settings.update({ session: { urls: [], active: 0 } });
    pushState();
    return settingsPayload();
  });
  ipc.handle('updates:check', LIBRARY, none, async () => {
    const state = await updates.check({ manual: true });
    return { status: state.status, version: state.version, mode: updates.mode };
  });
  ipc.handle('settings:choose-folder', LIBRARY, none, async () => {
    const result = await dialog.showOpenDialog(host.win, {
      title: 'Choose the recordings folder',
      defaultPath: getRecordingFolder(),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (!result.canceled && result.filePaths[0]) settings.update({ recordingFolder: result.filePaths[0] });
    return settingsPayload();
  });

  // Ad and tracker blocking: the toolbar's shield turns it off or on again for the current site,
  // and the settings page can remove sites from that list.
  ipc.handle('blocker:toggle-site', TOOLBAR, none, () => {
    const tab = tabs.active;
    const site = tab?.kind === 'web' ? hostOf(tab.view.webContents.getURL()) : '';
    if (!site) return null;
    const sites = settings.data.blockerAllowedSites;
    const allowed = !sites.includes(site);
    settings.update({ blockerAllowedSites: allowed ? [...sites, site] : sites.filter((known) => known !== site) });
    tab.view.webContents.reload();
    pushState();
    return { site, allowed };
  });
  ipc.handle('blocker:remove-site', LIBRARY, text, (_e, site) => {
    settings.update({ blockerAllowedSites: settings.data.blockerAllowedSites.filter((known) => known !== site) });
    pushState();
    return settingsPayload();
  });

  // Bookmarks page. Every change is saved, shown in the bookmarks bar and sent back.
  const saveBookmarks = (next) => {
    if (next) {
      settings.update({ bookmarks: next });
      pushState();
    }
    return settings.data.bookmarks;
  };
  ipc.handle('bookmarks:list', LIBRARY, none, () => settings.data.bookmarks);
  ipc.handle('bookmarks:rename', LIBRARY, twoTexts, (_e, url, title) => saveBookmarks(bookmarkList.rename(settings.data.bookmarks, url, title)));
  ipc.handle('bookmarks:remove', LIBRARY, text, (_e, url) => saveBookmarks(bookmarkList.remove(settings.data.bookmarks, url)));
  ipc.handle('bookmarks:move', LIBRARY, textAndIndex, (_e, url, index) => saveBookmarks(bookmarkList.move(settings.data.bookmarks, url, index)));
  ipc.handle('bookmarks:export', LIBRARY, none, async () => {
    const result = await dialog.showSaveDialog(host.win, {
      title: 'Export bookmarks',
      defaultPath: path.join(app.getPath('documents'), 'bookmarks.html'),
      filters: [{ name: 'Bookmarks file', extensions: ['html', 'htm'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    try {
      fs.writeFileSync(result.filePath, bookmarkList.toHtml(settings.data.bookmarks), 'utf8');
    } catch (error) {
      return { ok: false, message: error.message };
    }
    return { ok: true, count: settings.data.bookmarks.length, path: result.filePath };
  });
  ipc.handle('bookmarks:import', LIBRARY, none, async () => {
    const result = await dialog.showOpenDialog(host.win, {
      title: 'Import bookmarks',
      properties: ['openFile'],
      filters: [{ name: 'Bookmarks file', extensions: ['html', 'htm'] }],
    });
    const filePath = result.filePaths?.[0];
    if (result.canceled || !filePath) return { ok: false, canceled: true };
    let html;
    try {
      if (fs.statSync(filePath).size > MAX_IMPORT_BYTES) return { ok: false, message: 'That file is too large to be a bookmarks file.' };
      html = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      return { ok: false, message: error.message };
    }
    const merged = bookmarkList.merge(settings.data.bookmarks, bookmarkList.fromHtml(html), MAX_BOOKMARKS);
    saveBookmarks(merged.list);
    return { ok: true, added: merged.added, skipped: merged.skipped };
  });

  // History
  ipc.handle('history:list', LIBRARY, optionalText, (_e, query = '') => ({
    enabled: settings.data.historyEnabled,
    entries: history.list(query),
  }));
  ipc.handle('history:remove', LIBRARY, tabId, (_e, id) => history.remove(id));
  ipc.handle('history:clear', LIBRARY, none, () => { history.clear(); });

  // Downloads
  ipc.handle('downloads:list', LIBRARY, none, () => downloads.list());
  ipc.handle('downloads:cancel', LIBRARY, tabId, (_e, id) => downloads.cancel(id));
  ipc.handle('downloads:show', LIBRARY, tabId, (_e, id) => {
    const filePath = downloads.pathOf(id);
    if (filePath && fs.existsSync(filePath)) shell.showItemInFolder(filePath);
  });

  // Recordings and screenshots
  const recordingPath = (name) => (isSafeName(getRecordingFolder(), name) ? path.join(getRecordingFolder(), name) : null);
  ipc.handle('recordings:list', LIBRARY, none, () => ({
    folder: getRecordingFolder(),
    entries: listRecordings(getRecordingFolder(), recordingsIndex).map((entry) => ({ ...entry, url: mediaUrl(entry.name) })),
  }));
  ipc.handle('recordings:open', LIBRARY, text, async (_e, name) => {
    const target = recordingPath(name);
    if (!target || !fs.existsSync(target)) return false;
    return (await shell.openPath(target)) === '';
  });
  ipc.handle('recordings:reveal', LIBRARY, text, (_e, name) => {
    const target = recordingPath(name);
    if (target && fs.existsSync(target)) shell.showItemInFolder(target);
  });
  ipc.handle('recordings:rename', LIBRARY, twoTexts, (_e, name, newName) => {
    const result = renameRecording(getRecordingFolder(), name, newName, recordingsIndex);
    if (result.ok) broadcastToLibrary('recordings:changed');
    return result;
  });
  ipc.handle('recordings:delete', LIBRARY, text, async (_e, name) => {
    const result = await deleteRecording(getRecordingFolder(), name, (target) => shell.trashItem(target), recordingsIndex);
    if (result.ok) broadcastToLibrary('recordings:changed');
    return result;
  });
  ipc.handle('recordings:open-folder', LIBRARY, none, async () => {
    fs.mkdirSync(getRecordingFolder(), { recursive: true });
    await shell.openPath(getRecordingFolder());
  });
  ipc.handle('screenshot:take', TOOLBAR, none, () => actions.screenshot());

  // Recording control
  ipc.handle('recording:request-start', TOOLBAR, none, async () => {
    const result = await recorder.requestStart();
    return result.ok ? { ...result, quality: settings.data.recordingQuality } : result;
  });
  ipc.handle('recording:chunk', TOOLBAR, chunk, (_e, data) => recorder.write(data));
  ipc.handle('recording:request-stop', INDICATOR, none, () => ui.webContents.send('recording:command', 'stop'));
  ipc.handle('recording:request-pause', INDICATOR, none, () => actions.togglePause());
  ipc.handle('recording:set-paused', TOOLBAR, bool, (_e, paused) => recorder.setPaused(paused));
  ipc.handle('recording:rollover', TOOLBAR, none, async () => {
    const result = await recorder.rollover();
    return result.ok ? { ...result, quality: settings.data.recordingQuality } : result;
  });
  ipc.handle('recording:reauthorize', TOOLBAR, none, () => ({ ok: recorder.authorizeCapture() }));
  ipc.handle('recording:finish', TOOLBAR, none, () => recorder.finish());
  ipc.handle('recording:abort', TOOLBAR, none, async () => {
    await recorder.abort();
    notify('Recording could not start.', 'error');
  });
}

module.exports = { registerIpcHandlers };
