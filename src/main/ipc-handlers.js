// @ts-check
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
const { STOP_AFTER_CHOICES, DOWNLOADS_AT_ONCE_CHOICES, CONNECTIONS_CHOICES, MEMORY_SAVER_CHOICES } = require('./storage/settings');
const { hostOf } = require('./blocker');
const { checkLinks } = require('./link-check');
const { siteCookies, storageUsage, clearSiteData } = require('./site-info');
const { clearSummary, clearBrowsingData } = require('./privacy');

const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
const {
  isSafeName, listRecordings, renameRecording, deleteRecording, trimRecording, joinRecording, partsOf,
} = require('./recording/library');
const { writeRecording } = require('./recording/webm-edit');

// Which of the browser's own pages may call each channel (see ROLES in security/ipc-validate.js).
// The library tab shows titles and addresses that come from websites, so it gets no recording,
// navigation or tab controls; the toolbar gets no access to files, settings or history.
const TOOLBAR = ['toolbar'];
const INDICATOR = ['indicator'];
const BAR_AND_REC = ['toolbar', 'indicator'];
const FIND = ['find'];
const LIBRARY = ['library'];
const TOOLBAR_AND_LIBRARY = ['toolbar', 'library'];

// The recording indicator only needs the recording's state, not the tabs, addresses and bookmarks.
const indicatorState = (state) => ({ recording: state.recording });

// Every call from the browser's own pages comes through here. The sender, its page and the
// arguments are checked by `ipc.handle` before any handler runs.
function registerIpcHandlers(ipc, ctx) {
  const {
    app, shell, dialog, host, tabs, recorder, settings, history, downloads, recordingsIndex, blocker, refreshBlockerLists, updates,
    bookmarkIcons, keepBookmarkIcons,
    ui, find, actions, notify, pushState, buildState, getRecordingFolder, broadcastToLibrary, showMenu,
    videoFinder, openDownload, saveMedia, clipboard, whenDone, defaultDownloadDir, downloadFolders, fetchIn,
    permissionLog, certificates, cookieClock, regularSession, blockingActiveFor, toggleReader,
  } = ctx;
  const {
    none, tabId, entryId, tabMove, text, optionalText, twoTexts, textAndIndex, trimRange, bool, pixels, suggestQuery,
    bookmarkPatch, bookmarkMove, bookmarkId, bookmarkAction, idList, urlList, starSave, settingsPatch, findQuery, tabOptions, chunk,
    entryIdAndBool, listIndex, longText, addLinks, entryAndTarget, entryIdAndText, clearRange, clearRequest,
    tabIdAndBool, groupId, tabAndGroup, groupPatch,
  } = validators;

  const settingsPayload = () => ({
    ...pickEditable(settings.data),
    blockerAllowedSites: settings.data.blockerAllowedSites,
    recordingFolder: getRecordingFolder(),
    engines: Object.entries(SEARCH_ENGINES).map(([key, engine]) => ({ key, name: engine.name })),
    qualities: publicQualities(),
    stopAfterChoices: STOP_AFTER_CHOICES,
    downloadsAtOnceChoices: DOWNLOADS_AT_ONCE_CHOICES,
    connectionsChoices: CONNECTIONS_CHOICES,
    memorySaverChoices: MEMORY_SAVER_CHOICES,
  });

  // Tabs and navigation
  ipc.handle('ui:get-state', BAR_AND_REC, none, (event) => (event.sender === ui.webContents ? buildState() : indicatorState(buildState())));
  ipc.handle('tabs:create', TOOLBAR, tabOptions, (_e, opts = {}) => { tabs.create({ isPrivate: opts.private === true }); });
  ipc.handle('tabs:close', TOOLBAR, tabId, (_e, id) => tabs.close(id));
  ipc.handle('tabs:activate', TOOLBAR, tabId, (_e, id) => tabs.activate(id));
  ipc.handle('tabs:open', LIBRARY, text, (_e, url) => { if (isAllowedUrl(url)) tabs.create({ url }); });
  ipc.handle('tabs:move', TOOLBAR, tabMove, (_e, id, index) => tabs.move(id, index));
  ipc.handle('tabs:toggle-mute', TOOLBAR, tabId, (_e, id) => tabs.toggleMute(id));
  // Pinned tabs, sleeping tabs and tab groups (the tab strip's right-click menu and group chips).
  ipc.handle('tabs:pin', TOOLBAR, tabIdAndBool, (_e, id, pinned) => tabs.pin(id, pinned));
  ipc.handle('tabs:sleep', TOOLBAR, tabId, async (_e, id) => (await tabs.canSleep(id)) && tabs.sleep(id));
  ipc.handle('tabs:group-new', TOOLBAR, tabId, (_e, id) => tabs.newGroup(id));
  ipc.handle('tabs:group-add', TOOLBAR, tabAndGroup, (_e, id, group) => tabs.addToGroup(id, group));
  ipc.handle('tabs:group-remove', TOOLBAR, tabId, (_e, id) => tabs.removeFromGroup(id));
  ipc.handle('tabs:group-update', TOOLBAR, groupPatch, (_e, group, patch) => tabs.updateGroup(group, patch));
  ipc.handle('tabs:group-ungroup', TOOLBAR, groupId, (_e, group) => tabs.ungroup(group));
  ipc.handle('tabs:group-close', TOOLBAR, groupId, (_e, group) => tabs.closeGroup(group));
  ipc.handle('nav:go', TOOLBAR, text, (_e, input) => tabs.navigate(input).ok);
  ipc.handle('nav:back', TOOLBAR, none, () => tabs.back());
  ipc.handle('nav:forward', TOOLBAR, none, () => tabs.forward());
  ipc.handle('nav:reload', TOOLBAR, none, () => tabs.reload());
  ipc.handle('nav:stop', TOOLBAR, none, () => tabs.stop());
  ipc.handle('nav:home', TOOLBAR, none, () => tabs.goHome());
  ipc.handle('window:toggle-fullscreen', TOOLBAR, none, () => host.toggleFullscreen());
  ipc.handle('window:reveal', TOOLBAR, bool, (_e, revealed) => host.setRevealed(revealed));
  ipc.handle('window:menu', TOOLBAR, none, () => showMenu());
  ipc.handle('bookmarks:star', TOOLBAR, none, () => actions.starPage());
  ipc.handle('bookmarks:star-save', TOOLBAR, starSave, (_e, id, patch) => actions.saveStar(id, patch));
  ipc.handle('bookmarks:star-remove', TOOLBAR, text, (_e, id) => actions.removeStar(id));
  ipc.handle('bookmarks:folder', TOOLBAR, bookmarkId, (_e, id) => actions.bookmarkFolder(id));
  ipc.handle('bookmarks:action', TOOLBAR_AND_LIBRARY, bookmarkAction, (_e, id, action) => actions.bookmarkAction(id, action));
  ipc.handle('bookmarks:icons', TOOLBAR_AND_LIBRARY, urlList, (_e, urls) => bookmarkIcons.pick(urls));
  ipc.handle('zoom:reset', TOOLBAR, none, () => actions.zoom(0));

  // Address-bar suggestions: visited pages only while history is on.
  ipc.handle('suggest:query', TOOLBAR, suggestQuery, (_e, input, complete) => suggest({
    text: input,
    complete,
    history: settings.data.historyEnabled ? history.entries : [],
    bookmarks: bookmarkList.links(settings.data.bookmarks),
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
    host.setBookmarksBar(settings.data.showBookmarksBar);
    if (!settings.data.restoreTabs) settings.update({ session: { urls: [], active: 0 } });
    // A higher limit lets waiting downloads start.
    if (patch.downloadsAtOnce !== undefined) downloads.pump();
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

  // Ad and tracker blocking: the toolbar's shield opens a panel listing what was blocked on the
  // current page, with a switch that turns blocking off or on again for the site and a link to
  // the allowed sites in Settings; the settings page can remove sites from that list.
  ipc.handle('blocker:details', TOOLBAR, none, () => {
    const tab = tabs.active;
    const site = tab?.kind === 'web' ? hostOf(tab.view.webContents.getURL()) : '';
    if (!site) return null;
    // On an allowed site nothing is blocked, whatever the page asked for before it reloaded.
    const allowed = settings.data.blockerAllowedSites.includes(site);
    return {
      site,
      enabled: settings.data.blockTrackers,
      ready: blocker.ready,
      updatedAt: blocker.updatedAt,
      allowed,
      total: allowed ? 0 : tab.blocked ?? 0,
      hosts: allowed ? [] : tab.blockedLog?.summary() ?? [],
    };
  });
  ipc.handle('blocker:open-settings', TOOLBAR, none, () => { actions.openLibrary('settings'); });
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

  // Bookmarks page. Every change is saved, shown in the bookmarks bar and sent back as the
  // whole tree; a change that cannot be made (a folder into itself, say) sends it back unchanged.
  const saveBookmarks = (next) => {
    if (next) {
      settings.update({ bookmarks: next });
      keepBookmarkIcons();
      pushState();
    }
    return settings.data.bookmarks;
  };
  ipc.handle('bookmarks:list', LIBRARY, none, () => settings.data.bookmarks);
  ipc.handle('bookmarks:add-folder', LIBRARY, twoTexts, (_e, parentId, title) => {
    const added = bookmarkList.addFolder(settings.data.bookmarks, parentId, title);
    return { tree: saveBookmarks(added?.tree), id: added?.id ?? null };
  });
  ipc.handle('bookmarks:update', LIBRARY, bookmarkPatch, (_e, id, patch) => saveBookmarks(bookmarkList.update(settings.data.bookmarks, id, patch)));
  // Drag and drop on the Bookmarks page and on the bookmarks bar.
  ipc.handle('bookmarks:move', TOOLBAR_AND_LIBRARY, bookmarkMove, (event, id, parentId, index) => {
    const moved = bookmarkList.move(settings.data.bookmarks, id, parentId, index);
    // The star files new bookmarks where the user last put one.
    if (moved && bookmarkList.find(moved, id)?.node.type === 'link') settings.update({ bookmarkFolder: parentId });
    const tree = saveBookmarks(moved);
    // A drag on the bar: an open Bookmarks page shows the new order too.
    if (moved && event.sender === ui.webContents) broadcastToLibrary('bookmarks:changed');
    return tree;
  });
  ipc.handle('bookmarks:remove', LIBRARY, idList, (_e, ids) => saveBookmarks(bookmarkList.remove(settings.data.bookmarks, ids)));
  ipc.handle('bookmarks:open', LIBRARY, idList, (_e, ids) => actions.openBookmarks(ids));
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
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    return { ok: true, count: bookmarkList.links(settings.data.bookmarks).length, path: result.filePath };
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
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    const parsed = bookmarkList.fromHtml(html);
    const merged = bookmarkList.merge(settings.data.bookmarks, parsed);
    saveBookmarks(merged.tree);
    // Icons that came with the file, for the bookmarks that were added.
    for (const link of bookmarkList.links(merged.tree)) if (parsed.icons[link.url]) bookmarkIcons.set(link.url, parsed.icons[link.url]);
    return { ok: true, added: merged.added, skipped: merged.skipped };
  });

  // History
  ipc.handle('history:list', LIBRARY, optionalText, (_e, query = '') => ({
    enabled: settings.data.historyEnabled,
    entries: history.list(query),
  }));
  ipc.handle('history:remove', LIBRARY, entryId, (_e, id) => history.remove(id));
  ipc.handle('history:clear', LIBRARY, none, () => { history.clear(); });

  // Downloads. The toolbar's panel sees names and progress only (no addresses or folders), and
  // can pause, resume and open a finished download; everything else is on the Downloads page.
  ipc.handle('downloads:list', LIBRARY, none, () => downloads.list());
  ipc.handle('downloads:brief', TOOLBAR, none, () => downloads.brief());
  ipc.handle('downloads:pause', TOOLBAR_AND_LIBRARY, entryId, (_e, id) => downloads.pause(id));
  ipc.handle('downloads:resume', TOOLBAR_AND_LIBRARY, entryId, (_e, id) => downloads.resume(id));
  ipc.handle('downloads:open', TOOLBAR_AND_LIBRARY, entryId, (_e, id) => openDownload(id));
  ipc.handle('downloads:open-page', TOOLBAR, none, () => { actions.openLibrary('downloads'); });
  ipc.handle('downloads:cancel', LIBRARY, entryId, (_e, id) => downloads.cancel(id));
  ipc.handle('downloads:retry', LIBRARY, entryId, (_e, id) => downloads.retry(id));
  ipc.handle('downloads:remove', LIBRARY, entryId, (_e, id) => downloads.remove(id));
  ipc.handle('downloads:clear', LIBRARY, none, () => downloads.clearFinished());
  ipc.handle('downloads:pause-all', LIBRARY, none, () => downloads.pauseAll());
  ipc.handle('downloads:resume-all', LIBRARY, none, () => downloads.resumeAll());
  ipc.handle('downloads:open-when-done', LIBRARY, entryIdAndBool, (_e, id, open) => downloads.setOpenWhenDone(id, open));
  ipc.handle('downloads:copy-link', LIBRARY, entryId, (_e, id) => {
    const url = downloads.entry(id)?.url;
    if (url && isAllowedUrl(url)) clipboard.writeText(url);
  });
  ipc.handle('downloads:show', LIBRARY, entryId, (_e, id) => {
    const filePath = downloads.pathOf(id);
    if (filePath && fs.existsSync(filePath)) shell.showItemInFolder(filePath);
  });
  ipc.handle('downloads:move', LIBRARY, entryAndTarget, (_e, id, beforeId) => downloads.move(id, beforeId || null));
  ipc.handle('downloads:checksum', LIBRARY, entryIdAndText, (_e, id, value) => downloads.setChecksum(id, value));

  // Add links: the page checks pasted links (through the regular profile, as the downloads
  // will be), and adds them into the downloads folder or one the user picked in the dialog.
  ipc.handle('downloads:check-links', LIBRARY, longText, (_e, text) => checkLinks(fetchIn(null), text));
  ipc.handle('downloads:default-folder', LIBRARY, none, () => defaultDownloadDir);
  ipc.handle('downloads:choose-folder', LIBRARY, none, async () => {
    const result = await dialog.showOpenDialog(host.win, {
      title: 'Save the downloads in',
      defaultPath: defaultDownloadDir,
      properties: ['openDirectory', 'createDirectory'],
    });
    const folder = !result.canceled && result.filePaths[0];
    if (!folder) return null;
    downloadFolders.add(path.resolve(folder).toLowerCase());
    return folder;
  });
  ipc.handle('downloads:add-links', LIBRARY, addLinks, (_e, request) => {
    const folder = path.resolve(request.saveDir);
    if (!downloadFolders.has(folder.toLowerCase())) return { ok: false, reason: 'folder' };
    try {
      fs.mkdirSync(folder, { recursive: true });
    } catch {
      return { ok: false, reason: 'folder' };
    }
    const ids = downloads.addLinks({ ...request, saveDir: folder });
    return { ok: ids.length > 0, added: ids.length };
  });

  // The site info panel (the lock in the address bar): about the active tab's page only. The
  // site is always the tab's own address, never one the toolbar names.
  const activeSite = () => {
    const tab = tabs.active;
    if (tab?.kind !== 'web' || tab.crashed) return null;
    const contents = tab.view.webContents;
    const url = contents.getURL();
    return /^https?:\/\//i.test(url) ? { tab, contents, url } : null;
  };
  ipc.handle('site:info', TOOLBAR, none, async () => {
    const site = activeSite();
    if (!site) return null;
    const { tab, contents, url } = site;
    const { protocol, hostname, host: siteName } = new URL(url);
    const secure = protocol === 'https:';
    return {
      site: siteName,
      secure,
      certificate: secure ? certificates.get(contents.session, hostname) : null,
      permissions: permissionLog.list(contents.id),
      cookies: (await siteCookies(contents.session, hostname)).length,
      storageBytes: await storageUsage(contents),
      blocked: tab.blocked ?? 0,
      blocking: blockingActiveFor(url),
      zoom: Math.round(contents.getZoomFactor() * 100),
      httpsUrl: secure ? '' : url.replace(/^http:/i, 'https:'),
      isPrivate: tab.isPrivate,
    };
  });
  ipc.handle('site:clear-data', TOOLBAR, none, async () => {
    const site = activeSite();
    if (!site) return { ok: false };
    const { contents, url } = site;
    const { hostname } = new URL(url);
    const count = (await siteCookies(contents.session, hostname)).length;
    const { response } = await dialog.showMessageBox(host.win, {
      type: 'warning',
      title: 'Clear site data',
      message: `Clear cookies and site data for ${hostname}?`,
      detail: `${count} cookie${count === 1 ? '' : 's'} and everything ${hostname} stored in this browser will be removed. You'll be signed out of this site. Other sites are not touched.`,
      buttons: ['Clear data', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    if (response !== 0 || contents.isDestroyed()) return { ok: false };
    const result = await clearSiteData(contents.session, url);
    notify(`Cookies and stored data for ${hostname} cleared. You may need to sign in again.`);
    return { ok: true, cookies: result.cookies };
  });

  // Clear browsing data (Settings): the regular profile only; private tabs keep nothing.
  const privacyContext = () => ({ history, downloads, session: regularSession(), clock: cookieClock });
  ipc.handle('privacy:summary', LIBRARY, clearRange, (_e, range) => clearSummary({ range, ...privacyContext() }));
  ipc.handle('privacy:clear', LIBRARY, clearRequest, async (_e, range, what) => {
    const done = await clearBrowsingData({ range, what, ...privacyContext() });
    if (what.history) broadcastToLibrary('history:changed');
    return done;
  });

  // When all downloads finish: nothing, sleep or shut down (for this session; with a countdown).
  ipc.handle('downloads:when-done', LIBRARY, none, () => whenDone.state());
  ipc.handle('downloads:when-done-set', LIBRARY, text, (_e, action) => whenDone.set(action));
  ipc.handle('downloads:when-done-cancel', LIBRARY, none, () => whenDone.cancel());

  // The videos on the active tab's page, for the address bar's video panel. The panel names one
  // by its place in the list; the address comes from the main process's own scan of the page.
  ipc.handle('videos:list', TOOLBAR, none, async () => {
    const tab = tabs.active;
    if (tab?.kind !== 'web') return [];
    const videos = await videoFinder.scan(tab).catch(() => videoFinder.list(tab.id));
    return videos.map(({ kind, name, title, width, height, duration }, index) => ({ index, kind, name, title, width, height, duration }));
  });
  ipc.handle('videos:save', TOOLBAR, listIndex, (_e, index) => {
    const tab = tabs.active;
    const video = tab?.kind === 'web' ? videoFinder.list(tab.id)[index] : null;
    if (video?.kind !== 'file' || !isAllowedUrl(video.url)) return false;
    saveMedia(tab.view.webContents, video.url, 'video');
    return true;
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
  // Trimmed and joined copies are new files; a part still being recorded is left alone.
  const beingRecorded = (names) => Boolean(recorder.file) && names.includes(path.basename(recorder.file.filePath));
  ipc.handle('recordings:trim', LIBRARY, trimRange, async (_e, name, startMs, endMs) => {
    if (beingRecorded([name])) return { ok: false, reason: 'recording' };
    const result = await trimRecording(getRecordingFolder(), name, startMs, endMs, recordingsIndex, writeRecording);
    if (result.ok) broadcastToLibrary('recordings:changed');
    return result;
  });
  ipc.handle('recordings:join', LIBRARY, text, async (_e, name) => {
    if (beingRecorded(partsOf(getRecordingFolder(), name))) return { ok: false, reason: 'recording' };
    const result = await joinRecording(getRecordingFolder(), name, recordingsIndex, writeRecording);
    if (result.ok) broadcastToLibrary('recordings:changed');
    return result;
  });
  ipc.handle('recordings:open-folder', LIBRARY, none, async () => {
    fs.mkdirSync(getRecordingFolder(), { recursive: true });
    await shell.openPath(getRecordingFolder());
  });
  ipc.handle('screenshot:take', TOOLBAR, none, () => actions.screenshot());
  ipc.handle('screenshot:full', TOOLBAR, none, () => actions.fullScreenshot());

  // Reading mode, on the active tab's page (see reader.js).
  ipc.handle('reader:toggle', TOOLBAR, none, async () => {
    const tab = tabs.active;
    if (tab?.kind !== 'web' || tab.crashed) return null;
    try {
      const result = await toggleReader(tab.view.webContents);
      if (result === null) notify('This page has no article to show in reading mode.', 'warning');
      return result;
    } catch {
      notify('Reading mode could not open on this page.', 'warning');
      return null;
    }
  });

  // Recording control
  const captureOptions = () => ({ quality: settings.data.recordingQuality, microphone: settings.data.recordingMicrophone });
  ipc.handle('recording:request-start', TOOLBAR, none, async () => {
    const result = await recorder.requestStart();
    return result.ok ? { ...result, ...captureOptions() } : result;
  });
  ipc.handle('recording:chunk', TOOLBAR, chunk, (_e, data) => recorder.write(data));
  ipc.handle('recording:request-stop', INDICATOR, none, () => ui.webContents.send('recording:command', 'stop'));
  ipc.handle('recording:request-pause', INDICATOR, none, () => actions.togglePause());
  ipc.handle('recording:capture-started', TOOLBAR, none, () => recorder.captureStarted());
  ipc.handle('recording:microphone-failed', TOOLBAR, none, () => {
    notify('The microphone could not be used, so this recording has the page\'s sound only.', 'warning');
  });
  ipc.handle('recording:mark', BAR_AND_REC, none, () => Boolean(actions.addMarker()));
  ipc.handle('recording:set-paused', TOOLBAR, bool, (_e, paused) => recorder.setPaused(paused));
  ipc.handle('recording:rollover', TOOLBAR, none, async () => {
    const result = await recorder.rollover();
    return result.ok ? { ...result, ...captureOptions() } : result;
  });
  ipc.handle('recording:reauthorize', TOOLBAR, none, () => ({ ok: recorder.authorizeCapture() }));
  ipc.handle('recording:finish', TOOLBAR, none, () => recorder.finish());
  ipc.handle('recording:abort', TOOLBAR, none, async () => {
    await recorder.abort();
    notify('Recording could not start.', 'error');
  });
}

module.exports = { registerIpcHandlers, indicatorState };
