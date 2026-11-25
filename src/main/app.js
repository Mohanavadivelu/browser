'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, ipcMain, shell, dialog, Menu, clipboard, webContents, net, protocol, nativeImage, session } = require('electron');
const { BrowserWindow } = require('./window');
const { TabManager } = require('./tabs');
const { SessionManager, UI_PARTITION } = require('./sandbox/session-manager');
const { applyPermissionPolicy } = require('./security/permissions');
const { attachDownloadPolicy } = require('./security/downloads');
const { engineFor } = require('./security/navigation');
const { createIpc } = require('./security/ipc-validate');
const { Recorder } = require('./recording/recorder');
const { askRecordingConsent } = require('./recording/consent');
const { publicQualities } = require('./recording/quality');
const { RecordingIndex } = require('./recording/library');
const { saveScreenshot } = require('./recording/storage');
const { pdfFileName } = require('./recording/library');
const { MEDIA_SCHEME_PRIVILEGES, serveRecordings } = require('./recording/media-server');
const { APP_SCHEME_PRIVILEGES, WEB_FILES, isAppUrl, serveAppPages } = require('./app-scheme');
const { ContentBlocker, hostOf } = require('./blocker');
const bookmarkTree = require('./bookmarks');
const { BookmarkIcons } = require('./bookmark-icons');
const { UpdateService, updateMode, fetchLatestRelease, RELEASES } = require('./updates');
const { Settings } = require('./storage/settings');
const { History } = require('./storage/history');
const { DownloadManager } = require('./download-manager');
const { ZoomController } = require('./zoom');
const { createShortcutHandler } = require('./shortcuts');
const { FullscreenIdle } = require('./fullscreen-idle');
const { attachContextMenu } = require('./context-menu');
const { registerIpcHandlers, indicatorState } = require('./ipc-handlers');
const { showMainMenu } = require('./menus');

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const PRELOAD_PATH = path.join(__dirname, '..', 'preload', 'preload.js');
const SESSION_SAVE_DELAY_MS = 1000;
const DOWNLOAD_BROADCAST_MS = 200;
const BLOCKER_FIRST_UPDATE_MS = 10_000;
const AUTO_STOP_CHECK_MS = 250;
const MAX_OPEN_AT_ONCE = 50;
const BLOCKER_CHECK_MS = 6 * 60 * 60 * 1000;
// How long the toolbar gets to stop its capture and send the last chunks before the recording
// is closed without them.
const CAPTURE_STOP_TIMEOUT_MS = 3000;

const BLOCK_MESSAGES = {
  'blocked-scheme': 'Blocked: only http and https addresses can be opened.',
  'too-long': 'That address is too long.',
};
const EDIT_COMMANDS = new Set(['cut', 'copy', 'paste', 'selectAll']);

function cleanUserAgent(userAgent) {
  return userAgent.replace(/\s?Electron\/\S+/, '').replace(/\s?simple-browser\/\S+/i, '');
}

// Resolves when the page has finished loading, or after a short limit so capture is never blocked.
function waitUntilLoaded(contents, limitMs = 4000) {
  if (!contents || contents.isDestroyed() || !contents.isLoading()) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      contents.removeListener('did-stop-loading', done);
      resolve();
    };
    const timer = setTimeout(done, limitMs);
    contents.once('did-stop-loading', done);
  });
}

async function start(options = {}) {
  if (!app.isReady()) {
    app.enableSandbox();
    // One call for all of the app's schemes: Electron keeps only the last list it is given.
    protocol.registerSchemesAsPrivileged([APP_SCHEME_PRIVILEGES, MEDIA_SCHEME_PRIVILEGES]);
  }
  if (options.userDataDir) app.setPath('userData', options.userDataDir);
  if (!options.skipSingleInstanceLock && !app.requestSingleInstanceLock()) {
    app.quit();
    return null;
  }
  await app.whenReady();
  Menu.setApplicationMenu(null);

  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });

  const userData = app.getPath('userData');
  const settings = new Settings(path.join(userData, 'settings.json'));
  settings.load();
  const history = new History(path.join(userData, 'history.json'));
  history.load();
  const bookmarkIcons = new BookmarkIcons(path.join(userData, 'bookmark-icons.json'));
  bookmarkIcons.load();
  // Icons of pages no longer bookmarked are dropped.
  const keepBookmarkIcons = () => bookmarkIcons.keepOnly(bookmarkTree.links(settings.data.bookmarks).map((link) => link.url));
  keepBookmarkIcons();
  const recordingsIndex = new RecordingIndex(path.join(userData, 'recordings-index.json'));
  recordingsIndex.load();
  const downloads = new DownloadManager();

  // Ad and tracker blocking. Tests pass their own filters instead of downloading the lists.
  const blocker = new ContentBlocker({
    cacheDir: path.join(userData, 'blocker'),
    fetchText: async (url) => {
      const response = await net.fetch(url, { cache: 'no-cache' });
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
      return response.text();
    },
  });
  let refreshBlockerLists = () => {};
  if (typeof options.blockerFilters === 'string') {
    blocker.useFilters(options.blockerFilters);
  } else {
    blocker.loadCache();
    refreshBlockerLists = () => {
      if (!settings.data.blockTrackers || !blocker.stale) return;
      blocker.update()
        .then(() => pushState())
        .catch((error) => console.error(`Could not update the ad and tracker lists: ${error.message}`));
    };
    setTimeout(refreshBlockerLists, BLOCKER_FIRST_UPDATE_MS).unref?.();
    setInterval(refreshBlockerLists, BLOCKER_CHECK_MS).unref?.();
  }
  const blockingActiveFor = (pageUrl) => settings.data.blockTrackers &&
    !settings.data.blockerAllowedSites.includes(hostOf(pageUrl));
  const zoom = new ZoomController({ settings });

  // `options.dialog` stands in for the Save and Open dialogs in automated tests.
  const appDialog = options.dialog ?? dialog;
  // The browser's own pages, served before the window starts loading them.
  serveAppPages(session.fromPartition(UI_PARTITION), RENDERER_DIR);
  const host = new BrowserWindow({ preloadPath: PRELOAD_PATH });
  const { win, ui, indicator, find } = host;
  const getRecordingFolder = () => settings.data.recordingFolder ?? path.join(app.getPath('videos'), 'Simple Browser');

  let tabs;
  let recorder;
  let idle;
  let recordingTabId = null;

  const buildState = () => ({
    tabs: tabs.snapshot(),
    activeId: tabs.activeId,
    fullscreen: host.mode.fullscreen,
    htmlFullscreen: host.mode.htmlFullscreen,
    revealed: host.mode.revealed,
    recording: { ...recorder.info, limitMs: recordingLimitMs() },
    recordingQuality: settings.data.recordingQuality,
    qualities: publicQualities(),
    // The bar's own items (folders without their contents) and whether this page is bookmarked.
    bookmarks: settings.data.bookmarks.bar.children.map(({ id, type, title, url }) => ({ id, type, title, url, icon: Boolean(url && bookmarkIcons.get(url)) })),
    bookmarkIconsVersion: bookmarkIcons.version,
    otherBookmarks: settings.data.bookmarks.other.children.length,
    showBookmarksBar: settings.data.showBookmarksBar,
    bookmarked: Boolean(tabs.active?.kind === 'web' && bookmarkTree.findLinkByUrl(settings.data.bookmarks, tabs.active.view.webContents.getURL())),
    update: { status: updates.state.status, version: updates.state.version },
    blocker: {
      enabled: settings.data.blockTrackers,
      ready: blocker.ready,
      allowedSites: settings.data.blockerAllowedSites,
    },
  });

  let pushScheduled = false;
  const pushState = () => {
    if (pushScheduled) return;
    pushScheduled = true;
    setImmediate(() => {
      pushScheduled = false;
      if (win.isDestroyed()) return;
      const state = buildState();
      if (!ui.webContents.isDestroyed()) ui.webContents.send('ui:state', state);
      if (!indicator.webContents.isDestroyed()) indicator.webContents.send('ui:state', indicatorState(state));
    });
  };
  const notify = (text, kind = 'info') => {
    if (!ui.webContents.isDestroyed()) ui.webContents.send('ui:notice', { text, kind });
  };
  // A failed settings save is shown once a minute at most, not on every change.
  let settingsErrorShownAt = 0;
  settings.onSaveError = (error) => {
    if (Date.now() - settingsErrorShownAt < 60_000) return;
    settingsErrorShownAt = Date.now();
    notify(`Your settings could not be saved (${error.code ?? error.message}). Changes last until the browser closes.`, 'error');
  };
  // The Downloads / Recordings / History / Settings pages live in internal tabs.
  const broadcastToLibrary = (channel, payload) => {
    for (const contents of tabs.internalContents()) contents.send(channel, payload);
  };

  recorder = new Recorder({
    getFolder: getRecordingFolder,
    requestConsent: options.autoConsent
      ? async () => ({ granted: true })
      : () => askRecordingConsent(win, { microphone: settings.data.recordingMicrophone }),
    onChange: () => {
      host.setRecording(recorder.active);
      pushState();
    },
    notify,
    onFailure: () => { stopCapture(); },
    onSegment: (filePath, durationMs, final, { failed = false, markers = [] } = {}) => {
      if (recorder.removeIfEmpty(filePath)) {
        if (final && !failed) notify('The recording was empty and was not saved. Keep the page visible while recording.', 'error');
        return;
      }
      recordingsIndex.set(path.basename(filePath), durationMs);
      recordingsIndex.setMarkers(path.basename(filePath), markers);
      // After a write error the error notice stays up instead of a "saved" message.
      if (final && !failed) {
        notify(autoStopped ? `Recording stopped after ${autoStopped} min, as set in Settings, and saved: ${filePath}` : `Recording saved: ${filePath}`);
      }
      if (final) autoStopped = 0;
      broadcastToLibrary('recordings:changed');
    },
  });

  // Updates from GitHub Releases: installed copies update themselves, portable ones are told
  // where to download. Nothing is checked when running from source.
  const mode = options.updateMode ?? updateMode({ isPackaged: app.isPackaged });
  const updates = new UpdateService({
    mode,
    currentVersion: app.getVersion(),
    autoUpdater: mode === 'installer' ? require('electron-updater').autoUpdater : null,
    fetchLatest: () => fetchLatestRelease((url, init) => net.fetch(url, init), RELEASES),
    notify,
    isEnabled: () => settings.data.checkForUpdates,
  });
  updates.on('change', () => pushState());
  updates.start();

  // Stops a recording once it reaches the length chosen in Settings (paused time does not
  // count). `options.minuteMs` shortens a "minute" in tests.
  const minuteMs = options.minuteMs ?? 60_000;
  function recordingLimitMs() {
    return settings.data.recordingStopAfter * minuteMs;
  }
  let autoStopped = 0; // the limit in minutes, while a recording it stopped is being saved
  setInterval(() => {
    const limit = recordingLimitMs();
    if (!limit || !recorder.active || autoStopped || recorder.clock.elapsed() < limit) return;
    autoStopped = settings.data.recordingStopAfter;
    stopCapture().catch((error) => console.error(`Could not stop the recording: ${error.message}`));
  }, AUTO_STOP_CHECK_MS).unref?.();

  // Asks the toolbar to stop its capture, so the chunks it still holds are written, and makes
  // sure the recording ends even if the toolbar does not answer in time.
  const stopCapture = async () => {
    if (!recorder.active) return;
    if (!ui.webContents.isDestroyed()) ui.webContents.send('recording:command', 'stop');
    if (!(await recorder.whenIdle(CAPTURE_STOP_TIMEOUT_MS))) await recorder.finish();
  };

  const onBlocked = (_target, reason) => {
    if (reason === 'empty') return;
    notify(BLOCK_MESSAGES[reason] ?? BLOCK_MESSAGES['blocked-scheme'], 'warning');
  };

  const configureSession = (ses, kind) => {
    if (kind === 'ui') {
      // The browser's own views may ask for screen capture, but the handler below only grants it
      // to the main interface, right after the consent dialog.
      // The microphone only for the toolbar, only while a recording runs with narration turned on.
      applyPermissionPolicy(ses, new Set(['display-capture']), {
        allowMicrophone: (contents) => contents?.id === ui.webContents.id && settings.data.recordingMicrophone && recorder.active,
      });
      // Recordings and screenshots for the Recordings page's player; web sessions never get this.
      serveRecordings(ses, getRecordingFolder);
      ses.setDisplayMediaRequestHandler(async (request, callback) => {
        const requester = request.frame ? webContents.fromFrame(request.frame) : null;
        const allowed = requester?.id === ui.webContents.id && recorder.consumeAuthorization();
        // A tab that is still loading swaps its frame when the page commits, so wait for it to settle.
        if (allowed) await waitUntilLoaded(tabs.active?.view.webContents);
        // Capture the active tab's page and its sound; never other windows, apps or the microphone.
        const page = allowed ? tabs.active?.view.webContents.mainFrame : null;
        if (page) recordingTabId = tabs.activeId;
        callback(page ? { video: page, audio: page } : null);
      }, { useSystemPicker: false });
      return;
    }
    applyPermissionPolicy(ses);
    // Web tabs show the new tab page and the certificate warning, and nothing else of the app.
    serveAppPages(ses, RENDERER_DIR, WEB_FILES);
    blocker.attach(ses, {
      pageUrlOf: (details) => {
        const contents = details.webContentsId ? webContents.fromId(details.webContentsId) : null;
        return contents && !contents.isDestroyed() ? contents.getURL() : '';
      },
      isActive: blockingActiveFor,
      onBlocked: (contentsId) => tabs.countBlocked(contentsId),
    });
    attachDownloadPolicy(ses, {
      onBlocked: (name) => notify(`Blocked download of "${name}": executable files are not allowed.`, 'warning'),
      onStart: (item) => downloads.track(item),
      autoSaveDir: options.downloadDir,
      saveName: options.downloadSaveName,
    });
    ses.setUserAgent(cleanUserAgent(ses.getUserAgent()));
  };
  const sessions = new SessionManager(configureSession);
  sessions.ensure(UI_PARTITION, 'ui');

  let shortcutHandler = () => {};
  const trackInput = (contents) => {
    contents.on('before-input-event', (event, input) => {
      idle?.activity();
      shortcutHandler(event, input, contents);
    });
    contents.on('before-mouse-event', () => idle?.activity());
  };

  tabs = new TabManager({
    host,
    sessions,
    zoom,
    preloadPath: PRELOAD_PATH,
    newTabPage: 'newtab.html',
    warningPage: 'warning.html',
    libraryPage: 'library.html',
    getEngine: () => settings.data.searchEngine,
    getHome: () => settings.data.homePage,
    onBlocked,
    onInput: trackInput,
  });
  idle = new FullscreenIdle({ host, tabs, idleMs: options.idleMs });

  // Right-click menus: full menu in web pages, only edit commands in the browser's own text boxes.
  const edit = (contents) => (name) => { if (EDIT_COMMANDS.has(name)) contents[name](); };
  tabs.on('created', (tab) => {
    const contents = tab.view.webContents;
    attachContextMenu(contents, win, () => ({
      openInNewTab: (url) => tabs.create({ url, isPrivate: tab.isPrivate }),
      copyText: (text) => clipboard.writeText(text),
      saveImage: (url) => contents.downloadURL(url),
      copyImage: (x, y) => contents.copyImageAt(x, y),
      edit: edit(contents),
      searchFor: (text) => tabs.create({ url: engineFor(settings.data.searchEngine).url + encodeURIComponent(text), isPrivate: tab.isPrivate }),
      searchEngine: () => settings.data.searchEngine,
      navigation: {
        canGoBack: () => contents.navigationHistory.canGoBack(),
        canGoForward: () => contents.navigationHistory.canGoForward(),
        back: () => contents.navigationHistory.goBack(),
        forward: () => contents.navigationHistory.goForward(),
        reload: () => contents.reload(),
      },
    }));
  });
  for (const view of [ui, find]) {
    attachContextMenu(view.webContents, win, () => ({ edit: edit(view.webContents), searchEngine: () => settings.data.searchEngine }));
  }

  // History is only written when the user has turned it on, and never for private tabs.
  const shouldRecordHistory = (tab) => settings.data.historyEnabled && !tab.isPrivate && tab.kind === 'web';
  tabs.on('navigated', (tab, url, { inPage = false } = {}) => {
    if (shouldRecordHistory(tab)) history.add({ url, title: tab.title, inPage });
  });
  tabs.on('titled', (tab, url, title) => {
    if (shouldRecordHistory(tab)) history.updateTitle(url, title);
  });

  tabs.on('found', (tab, result) => {
    if (tab.id !== tabs.activeId || !result.finalUpdate) return;
    find.webContents.send('find:result', { active: result.activeMatchOrdinal, matches: result.matches });
  });
  host.on('find-change', (open) => {
    if (open) return;
    const contents = tabs.active?.view.webContents;
    contents?.stopFindInPage('clearSelection');
    contents?.focus();
  });

  tabs.on('activated', (id) => {
    host.closeFind();
    if (recorder.active && settings.data.recordingFollowTab && id !== recordingTabId) {
      ui.webContents.send('recording:command', 'retarget');
    }
  });

  let downloadTimer = null;
  downloads.on('started', (entry) => notify(`Downloading ${entry.filename}…`));
  downloads.on('completed', (entry) => notify(`Download complete: ${entry.filename}`));
  downloads.on('change', () => {
    if (downloadTimer) return;
    downloadTimer = setTimeout(() => {
      downloadTimer = null;
      broadcastToLibrary('downloads:changed', downloads.list());
    }, DOWNLOAD_BROADCAST_MS);
  });

  // Session restore: only regular web tabs are remembered, and only if the user turned it on.
  let sessionTimer = null;
  const saveSession = () => {
    clearTimeout(sessionTimer);
    sessionTimer = null;
    if (settings.data.restoreTabs) settings.update({ session: tabs.sessionSnapshot() });
    else if (settings.data.session.urls.length) settings.update({ session: { urls: [], active: 0 } });
  };
  const scheduleSessionSave = () => {
    if (!settings.data.restoreTabs || sessionTimer) return;
    sessionTimer = setTimeout(saveSession, SESSION_SAVE_DELAY_MS);
    sessionTimer.unref?.();
  };
  tabs.on('navigated', scheduleSessionSave);
  tabs.on('activated', scheduleSessionSave);
  // Closing a tab in the background activates nothing, but it still changes the session.
  tabs.on('closed', scheduleSessionSave);

  // Actions shared by keyboard shortcuts, menus and the interface.
  const actions = {
    toggleBookmark: () => {
      const tab = tabs.active;
      if (!tab || tab.kind !== 'web') return;
      if (tab.isPrivate) {
        notify('Bookmarks are not saved from private tabs.', 'warning');
        return;
      }
      const url = tab.view.webContents.getURL();
      const tree = settings.data.bookmarks;
      const existing = bookmarkTree.findLinkByUrl(tree, url);
      if (existing) {
        settings.update({ bookmarks: bookmarkTree.remove(tree, [existing.id]) });
        keepBookmarkIcons();
      } else {
        const added = bookmarkTree.addLink(tree, settings.data.bookmarkFolder, { url, title: tab.title || url });
        if (!added) {
          notify('This page could not be bookmarked.', 'warning');
          return;
        }
        settings.update({ bookmarks: added.tree });
        if (tab.favicon) bookmarkIcons.set(url, tab.favicon);
      }
      notify(existing ? 'Bookmark removed.' : 'Bookmark added.');
      broadcastToLibrary('bookmarks:changed');
      pushState();
    },
    // A bookmarks folder on the bar, as a menu at (x, y) in the window: its bookmarks open in the
    // current tab, its folders are submenus, and "Open all" opens its links in new tabs.
    showBookmarkFolder: (folderId, x, y) => {
      const folder = bookmarkTree.find(settings.data.bookmarks, folderId)?.node;
      if (!folder || folder.type !== 'folder') return false;
      Menu.buildFromTemplate(bookmarkMenuTemplate(folder)).popup({ window: win, x, y });
      return true;
    },
    // The bar's bookmarks that do not fit, under ».
    showBookmarkItems: (ids, x, y) => {
      const template = bookmarkItemsTemplate(ids);
      if (template.length === 0) return false;
      Menu.buildFromTemplate(template).popup({ window: win, x, y });
      return true;
    },
    // Right-click on a bookmark or folder on the bar.
    showBookmarkContext: (id, x, y) => {
      const template = bookmarkContextTemplate(id);
      if (!template) return false;
      Menu.buildFromTemplate(template).popup({ window: win, x, y });
      return true;
    },
    // Opens the Bookmarks page on this bookmark's folder, with its name and address ready to edit.
    editBookmark: (id) => {
      const page = tabs.openInternal('bookmarks');
      const reveal = () => page.view.webContents.send('bookmarks:reveal', id);
      if (page.view.webContents.isLoading()) page.view.webContents.once('did-finish-load', reveal);
      else reveal();
    },
    deleteBookmark: async (id) => {
      const found = bookmarkTree.find(settings.data.bookmarks, id);
      if (!found || found.parent === null) return false;
      const { node } = found;
      const inside = node.type === 'folder' ? bookmarkUrls([id]).length : 0;
      if (inside > 0) {
        const { response } = await appDialog.showMessageBox(win, {
          type: 'warning',
          message: `Delete the folder “${node.title}” and the ${inside} bookmark${inside === 1 ? '' : 's'} in it?`,
          buttons: ['Delete', 'Cancel'],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
        });
        if (response !== 0) return false;
      }
      settings.update({ bookmarks: bookmarkTree.remove(settings.data.bookmarks, [id]) });
      keepBookmarkIcons();
      notify(node.type === 'folder' ? `Deleted the folder “${node.title}”.` : 'Bookmark deleted.');
      broadcastToLibrary('bookmarks:changed');
      pushState();
      return true;
    },
    // The star (☆ or Ctrl+D): bookmarks the page into the folder used last if it is not yet
    // bookmarked, and returns what the star's popover shows. Null for pages that cannot be.
    starPage: () => {
      const tab = tabs.active;
      if (!tab || tab.kind !== 'web') return null;
      if (tab.isPrivate) {
        notify('Bookmarks are not saved from private tabs.', 'warning');
        return null;
      }
      const url = tab.view.webContents.getURL();
      let tree = settings.data.bookmarks;
      let link = bookmarkTree.findLinkByUrl(tree, url);
      const added = !link;
      if (added) {
        const result = bookmarkTree.addLink(tree, settings.data.bookmarkFolder, { url, title: tab.title || url });
        if (!result) {
          notify('This page could not be bookmarked.', 'warning');
          return null;
        }
        settings.update({ bookmarks: result.tree });
        if (tab.favicon) bookmarkIcons.set(url, tab.favicon);
        tree = settings.data.bookmarks;
        link = bookmarkTree.findLinkByUrl(tree, url);
        broadcastToLibrary('bookmarks:changed');
        pushState();
      }
      const found = bookmarkTree.find(tree, link.id);
      return {
        added,
        id: link.id,
        title: link.title,
        folderId: found.parent.id,
        folders: bookmarkTree.folders(tree).map(({ id, label }) => ({ id, label })),
      };
    },
    // Done in the star's popover: the name, and the folder (a new one is made in the bar).
    saveStar: (id, { title, folderId, newFolder }) => {
      let tree = settings.data.bookmarks;
      const found = bookmarkTree.find(tree, id);
      if (!found || found.node.type !== 'link') return false;
      let target = folderId ?? found.parent.id;
      if (newFolder !== undefined) {
        const made = bookmarkTree.addFolder(tree, 'bar', newFolder);
        if (!made) return false;
        tree = made.tree;
        target = made.id;
      }
      if (title !== undefined) tree = bookmarkTree.update(tree, id, { title }) ?? tree;
      if (target !== found.parent.id) tree = bookmarkTree.move(tree, id, target, 10000) ?? tree;
      settings.update({ bookmarks: tree, bookmarkFolder: target });
      broadcastToLibrary('bookmarks:changed');
      pushState();
      return true;
    },
    removeStar: (id) => {
      const next = bookmarkTree.remove(settings.data.bookmarks, [id]);
      if (!next) return false;
      settings.update({ bookmarks: next });
      keepBookmarkIcons();
      notify('Bookmark removed.');
      broadcastToLibrary('bookmarks:changed');
      pushState();
      return true;
    },
    // Ctrl+D: the toolbar opens the star's popover.
    openStar: () => {
      host.setRevealed(true);
      ui.webContents.focus();
      ui.webContents.send('ui:star');
    },
    toggleBookmarksBar: () => {
      settings.update({ showBookmarksBar: !settings.data.showBookmarksBar });
      host.setBookmarksBar(settings.data.showBookmarksBar);
      pushState();
    },
    openBookmarks: (ids) => {
      const urls = bookmarkUrls(ids);
      urls.slice(0, MAX_OPEN_AT_ONCE).forEach((url, i) => tabs.create({ url, activate: i === 0 }));
      if (urls.length > MAX_OPEN_AT_ONCE) notify(`Opened the first ${MAX_OPEN_AT_ONCE} of ${urls.length} bookmarks.`, 'warning');
      return Math.min(urls.length, MAX_OPEN_AT_ONCE);
    },
    zoom: (direction) => {
      const tab = tabs.active;
      if (!tab || tab.kind !== 'web') return;
      const factor = zoom.change(tab, direction);
      if (factor === null) return;
      pushState();
      notify(`Zoom ${Math.round(factor * 100)}%`);
    },
    find: () => host.openFind(),
    openLibrary: (page) => tabs.openInternal(page),
    toggleRecording: () => ui.webContents.send('recording:command', recorder.active ? 'stop' : 'start'),
    // A marker at the current moment of the recording (Ctrl+Shift+M, or Mark on the REC controls).
    addMarker: () => {
      const marker = recorder.addMarker();
      if (!marker) return null;
      const seconds = Math.floor(marker.timeMs / 1000);
      const at = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
      notify(`Marker ${marker.number} at ${at}${marker.part > 1 ? ` in part ${marker.part}` : ''}`);
      return marker;
    },
    togglePause: () => {
      if (recorder.active) ui.webContents.send('recording:command', 'toggle-pause');
    },
    // The system print dialog for the current page.
    print: () => {
      const tab = tabs.active;
      if (!tab || tab.kind !== 'web') return;
      tab.view.webContents.print({}, (success, reason) => {
        if (!success && reason !== 'cancelled' && reason !== 'Print job canceled') notify(`Could not print: ${reason}`, 'error');
      });
    },
    // Saves the current page as a PDF, named after its title.
    savePdf: async () => {
      const tab = tabs.active;
      if (!tab || tab.kind !== 'web') return null;
      const result = await appDialog.showSaveDialog(win, {
        title: 'Save page as PDF',
        defaultPath: path.join(app.getPath('documents'), pdfFileName(tab.title)),
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
      });
      if (result.canceled || !result.filePath) return null;
      try {
        const pdf = await tab.view.webContents.printToPDF({ printBackground: true });
        fs.writeFileSync(result.filePath, pdf);
      } catch (error) {
        notify(`Could not save the PDF: ${error.message}`, 'error');
        return null;
      }
      notify(`Saved PDF: ${result.filePath}`);
      return result.filePath;
    },
    screenshot: async () => {
      const tab = tabs.active;
      if (!tab) return null;
      try {
        const image = await tab.view.webContents.capturePage();
        if (image.isEmpty()) throw new Error('The page is not visible.');
        const filePath = saveScreenshot(getRecordingFolder(), image.toPNG());
        notify(`Screenshot saved: ${filePath}`);
        broadcastToLibrary('recordings:changed');
        return filePath;
      } catch (error) {
        notify(`Could not capture a screenshot: ${error.message}`, 'error');
        return null;
      }
    },
  };

  // Every link under the given bookmarks and folders, in order.
  function bookmarkUrls(ids) {
    const urls = [];
    const collect = (node) => {
      if (node.type === 'link') urls.push(node.url);
      else node.children.forEach(collect);
    };
    for (const id of ids) {
      const node = bookmarkTree.find(settings.data.bookmarks, id)?.node;
      if (node) collect(node);
    }
    return urls;
  }

  // Windows menus read "&" as an access key; "&&" shows one "&".
  const menuLabel = (text) => text.replace(/&/g, '&&');
  // A bookmark's site icon for a menu, if it has one the system can draw.
  function menuIcon(url) {
    const data = bookmarkIcons.get(url);
    if (!data) return undefined;
    const image = nativeImage.createFromDataURL(data);
    return image.isEmpty() ? undefined : image.resize({ width: 16, height: 16 });
  }
  const menuItemFor = (node) => (node.type === 'folder'
    ? { label: menuLabel(node.title), submenu: bookmarkMenuTemplate(node) }
    : { label: menuLabel(node.title), icon: menuIcon(node.url), click: () => tabs.navigate(node.url) });
  function bookmarkItemsTemplate(ids) {
    return ids.map((id) => bookmarkTree.find(settings.data.bookmarks, id)?.node).filter(Boolean).map(menuItemFor);
  }
  function bookmarkContextTemplate(id) {
    const found = bookmarkTree.find(settings.data.bookmarks, id);
    if (!found) return null;
    const { node } = found;
    const fixed = found.parent === null; // Bookmarks bar and Other bookmarks
    if (node.type === 'link') {
      return [
        { label: 'Open', click: () => tabs.navigate(node.url) },
        { label: 'Open in new tab', click: () => tabs.create({ url: node.url }) },
        { label: 'Open in private tab', click: () => tabs.create({ url: node.url, isPrivate: true }) },
        { type: 'separator' },
        { label: 'Edit…', click: () => actions.editBookmark(id) },
        { label: 'Delete', click: () => actions.deleteBookmark(id) },
      ];
    }
    const count = bookmarkUrls([id]).length;
    return [
      { label: `Open all (${count}) in new tabs`, enabled: count > 0, click: () => actions.openBookmarks([id]) },
      ...(fixed ? [] : [
        { type: 'separator' },
        { label: 'Rename…', click: () => actions.editBookmark(id) },
        { label: 'Delete', click: () => actions.deleteBookmark(id) },
      ]),
    ];
  }
  function bookmarkMenuTemplate(folder) {
    const items = folder.children.map(menuItemFor);
    if (items.length === 0) return [{ label: '(empty)', enabled: false }];
    const count = bookmarkUrls([folder.id]).length;
    if (count > 0) items.push({ type: 'separator' }, { label: `Open all (${count}) in new tabs`, click: () => actions.openBookmarks([folder.id]) });
    return items;
  }

  shortcutHandler = createShortcutHandler({ tabs, host, ui, actions });
  for (const view of [ui, indicator, find]) trackInput(view.webContents);

  // The trailing slash keeps a sibling folder such as "renderer-old" from matching.

  // Which of the browser's own pages sent an IPC call, or null for anything else.
  const senderRole = (event) => {
    const frame = event.senderFrame;
    if (!frame || frame !== event.sender.mainFrame || !isAppUrl(frame.url)) return null;
    const id = event.sender.id;
    if (id === ui.webContents.id) return 'toolbar';
    if (id === indicator.webContents.id) return 'indicator';
    if (id === find.webContents.id) return 'find';
    if (tabs.internalContents().some((contents) => contents.id === id)) return 'library';
    return null;
  };
  const ipc = createIpc(ipcMain, senderRole);

  const context = {
    app, shell, host, dialog: appDialog, blocker, refreshBlockerLists, updates, bookmarkIcons, keepBookmarkIcons, tabs, recorder, settings, history, downloads, recordingsIndex, zoom,
    ui, find, actions, notify, pushState, buildState, getRecordingFolder, broadcastToLibrary,
    showMenu: () => showMainMenu(context),
  };
  registerIpcHandlers(ipc, context);

  host.on('mode-change', pushState);
  host.setBookmarksBar(settings.data.showBookmarksBar);
  // A bookmarked page's icon is kept for the bookmarks bar and menus (never from private tabs).
  tabs.on('favicon', (tab, url, icon) => {
    if (tab.isPrivate || tab.kind !== 'web' || !bookmarkTree.findLinkByUrl(settings.data.bookmarks, url)) return;
    if (bookmarkIcons.set(url, icon)) {
      pushState();
      broadcastToLibrary('bookmarks:changed');
    }
  });
  tabs.on('change', pushState);

  // A running recording is stopped through the toolbar first, so its last second is kept.
  let closing = false;
  win.on('close', (event) => {
    saveSession();
    history.flush();
    bookmarkIcons.flush();
    if (!recorder.active) return;
    event.preventDefault();
    if (closing) return;
    closing = true;
    stopCapture()
      .catch((error) => console.error(`Could not stop the recording: ${error.message}`))
      .finally(() => {
        if (recorder.active) win.destroy();
        else win.close();
      });
  });
  // Starting the app again (it holds the single-instance lock) brings this window forward
  // instead of the second start quitting with nothing on screen.
  const onSecondInstance = () => {
    if (win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  };
  if (!options.skipSingleInstanceLock) app.on('second-instance', onSecondInstance);

  win.on('closed', () => {
    // A closed window leaves the pages of its views running; close them, so a toolbar or tab of a
    // closed window cannot keep calling in (the tests open several windows in one process).
    const pages = [ui, indicator, find, ...[...tabs.tabs.values()].map((tab) => tab.view)].map((view) => view.webContents);
    for (const contents of pages) {
      if (!contents.isDestroyed()) contents.close();
    }
    if (options.quitOnClose !== false) app.quit();
  });

  const restored = settings.data.restoreTabs ? settings.data.session : { urls: [], active: 0 };
  if (restored.urls.length) {
    restored.urls.forEach((url) => tabs.create({ url, activate: false }));
    tabs.activate(tabs.order[restored.active] ?? tabs.order[0]);
  } else {
    tabs.create({ url: settings.data.homePage || undefined });
  }
  ui.webContents.once('did-finish-load', () => {
    // The window can be closed before the toolbar has finished loading.
    if (win.isDestroyed()) return;
    host.layout();
    win.show();
    pushState();
  });

  return {
    app, host, tabs, recorder, settings, history, downloads, recordingsIndex, zoom,
    ui, indicator, find, win, idle, actions, saveSession, stopCapture, updates, bookmarkIcons,
    // The bookmark menus' items, for tests (the menus themselves are native popups).
    bookmarkMenus: { folder: (id) => bookmarkMenuTemplate(bookmarkTree.find(settings.data.bookmarks, id).node), items: bookmarkItemsTemplate, context: bookmarkContextTemplate },
  };
}

module.exports = { start };
