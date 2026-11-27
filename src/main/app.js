'use strict';

// The composition root: creates the window, sessions, tabs and services, wires them together,
// and returns them (the smoke tests drive the app through what start() returns).
const path = require('node:path');
const { app, ipcMain, shell, dialog, Menu, clipboard, net, protocol, session } = require('electron');
const { BrowserWindow } = require('./window');
const { TabManager } = require('./tabs');
const { SessionManager, UI_PARTITION, REGULAR_PARTITION } = require('./sandbox/session-manager');
const { engineFor } = require('./security/navigation');
const { createIpc } = require('./security/ipc-validate');
const { askRecordingConsent } = require('./recording/consent');
const { publicQualities } = require('./recording/quality');
const { RecordingIndex } = require('./recording/library');
const { MEDIA_SCHEME_PRIVILEGES } = require('./recording/media-server');
const { createRecordingController } = require('./recording/recording-controller');
const { APP_SCHEME_PRIVILEGES, isAppUrl, serveAppPages } = require('./app-scheme');
const { createSessionSetup } = require('./session-setup');
const { ContentBlocker, hostOf } = require('./blocker');
const bookmarkTree = require('./bookmarks');
const { BookmarkIcons } = require('./bookmark-icons');
const { createBookmarkActions } = require('./actions/bookmark-actions');
const { createPageActions } = require('./actions/page-actions');
const { UpdateService, updateMode, fetchLatestRelease, RELEASES } = require('./updates');
const { Settings } = require('./storage/settings');
const { History } = require('./storage/history');
const { DownloadManager } = require('./download-manager');
const { VideoFinder } = require('./page-videos');
const { isDangerousFile, setInternetMark } = require('./security/downloads');
const { SegmentedDownload, probeRanges } = require('./segmented-download');
const { WhenDone } = require('./when-done');
const { PermissionLog, CertificateLog } = require('./site-info');
const { CookieClock } = require('./privacy');
const { ZoomController } = require('./zoom');
const { createShortcutHandler } = require('./shortcuts');
const { FullscreenIdle } = require('./fullscreen-idle');
const { attachContextMenu } = require('./context-menu');
const { registerIpcHandlers, indicatorState } = require('./ipc-handlers');
const { showMainMenu } = require('./menus');
const { isLive } = require('./live');

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const PRELOAD_PATH = path.join(__dirname, '..', 'preload', 'preload.js');
const SESSION_SAVE_DELAY_MS = 1000;
const DOWNLOAD_BROADCAST_MS = 200;
const BLOCKER_FIRST_UPDATE_MS = 10_000;
const BLOCKER_CHECK_MS = 6 * 60 * 60 * 1000;

const BLOCK_MESSAGES = {
  'blocked-scheme': 'Blocked: only http and https addresses can be opened.',
  'too-long': 'That address is too long.',
};
const EDIT_COMMANDS = new Set(['cut', 'copy', 'paste', 'selectAll']);

// What has to happen before Electron is ready: the sandbox, and the browser's own schemes.
// start() does it when it is called that early; a caller that waits first calls this itself.
let prepared = false;
function prepare() {
  if (prepared || app.isReady()) return;
  prepared = true;
  app.enableSandbox();
  // One call for all of the app's schemes: Electron keeps only the last list it is given.
  protocol.registerSchemesAsPrivileged([APP_SCHEME_PRIVILEGES, MEDIA_SCHEME_PRIVILEGES]);
}

async function start(options = {}) {
  prepare();
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

  // ---------- Stored data ----------
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
  // Retries that start over, and downloads saved from last time, use the regular profile; the
  // list of private tabs' downloads is never saved, so they never come back.
  let sessions;
  // A split download's connections go through the session it started in (its cookies, proxy
  // and blocking rules); one saved from last time, through the regular profile.
  const fetchIn = (ses) => (url, init) => (ses ?? sessions.ensure(REGULAR_PARTITION)).fetch(url, init);
  const downloads = new DownloadManager({
    storePath: path.join(userData, 'downloads.json'),
    maxActive: () => settings.data.downloadsAtOnce,
    startDownload: (url) => sessions.ensure(REGULAR_PARTITION).downloadURL(url),
    createInterrupted: (details) => sessions.ensure(REGULAR_PARTITION).createInterruptedDownload(details),
    speedLimit: () => settings.data.speedLimitKBps * 1024,
    segmented: {
      connections: () => settings.data.connectionsPerFile,
      probe: (details) => probeRanges(fetchIn(details.session), details),
      create: (details) => new SegmentedDownload({ ...details, fetch: fetchIn(details.session) }),
    },
    nightWindow: () => (settings.data.downloadNightOnly ? { from: settings.data.downloadNightFrom, to: settings.data.downloadNightTo } : null),
  });
  // Folders the Downloads page may save added links into: the downloads folder, and those the
  // user picked in the folder dialog (the page can't name any other).
  const defaultDownloadDir = options.downloadDir ?? app.getPath('downloads');
  const downloadFolders = new Set([path.resolve(defaultDownloadDir).toLowerCase()]);
  const savedDownloads = downloads.load();
  // For the site info panel and clearing browsing data.
  const permissionLog = new PermissionLog();
  const certificates = new CertificateLog();
  const cookieClock = new CookieClock({ filePath: path.join(userData, 'cookie-times.json') });
  cookieClock.load();
  const zoom = new ZoomController({ settings });

  // ---------- Ad and tracker blocking ----------
  // Tests pass their own filters instead of downloading the lists.
  const blocker = new ContentBlocker({
    cacheDir: path.join(userData, 'blocker'),
    fetchText: async (url) => {
      const response = await net.fetch(url, { cache: 'no-cache' });
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
      return response.text();
    },
  });
  let refreshBlockerLists = () => {};
  if (options.blockerFilters != null) {
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

  // ---------- The window ----------
  // `options.dialog` stands in for the Save and Open dialogs in automated tests.
  const appDialog = options.dialog ?? dialog;
  // The browser's own pages, served before the window starts loading them.
  serveAppPages(session.fromPartition(UI_PARTITION), RENDERER_DIR);
  const host = new BrowserWindow({ preloadPath: PRELOAD_PATH });
  const { win, ui, indicator, find } = host;
  const getRecordingFolder = () => settings.data.recordingFolder ?? path.join(app.getPath('videos'), 'Simple Browser');

  let tabs;
  let idle;
  const videoFinder = new VideoFinder({ onChange: (tabId) => { if (tabId === tabs.activeId) pushState(); } });

  // ---------- What the browser's own pages are told ----------
  const buildState = () => ({
    tabs: tabs.snapshot(),
    activeId: tabs.activeId,
    fullscreen: host.mode.fullscreen,
    htmlFullscreen: host.mode.htmlFullscreen,
    revealed: host.mode.revealed,
    recording: recording.state(),
    recordingQuality: settings.data.recordingQuality,
    qualities: publicQualities(),
    // The bar's own items (folders without their contents) and whether this page is bookmarked.
    bookmarks: settings.data.bookmarks.bar.children.map(({ id, type, title, url }) => ({ id, type, title, url, icon: Boolean(url && bookmarkIcons.get(url)) })),
    bookmarkIconsVersion: bookmarkIcons.version,
    otherBookmarks: settings.data.bookmarks.other.children.length,
    showBookmarksBar: settings.data.showBookmarksBar,
    bookmarked: Boolean(tabs.active?.kind === 'web' && bookmarkTree.findLinkByUrl(settings.data.bookmarks, tabs.active.view.webContents.getURL())),
    // Videos on the active tab's page (for the address bar's video button).
    videos: tabs.activeId ? videoFinder.list(tabs.activeId).length : 0,
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
      if (isLive(ui.webContents)) ui.webContents.send('ui:state', state);
      if (isLive(indicator.webContents)) indicator.webContents.send('ui:state', indicatorState(state));
    });
  };
  const notify = (text, kind = 'info') => {
    if (isLive(ui.webContents)) ui.webContents.send('ui:notice', { text, kind });
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

  // ---------- Recording ----------
  const recording = createRecordingController({
    settings,
    host,
    ui,
    getTabs: () => tabs,
    getFolder: getRecordingFolder,
    recordingsIndex,
    notify,
    pushState,
    broadcastToLibrary,
    requestConsent: options.autoConsent
      ? async () => ({ granted: true })
      : () => askRecordingConsent(win, { microphone: settings.data.recordingMicrophone }),
    minuteMs: options.minuteMs,
  });
  const { recorder, stopCapture } = recording;

  // ---------- Updates ----------
  // From GitHub Releases: installed copies update themselves, portable ones are told where to
  // download. Nothing is checked when running from source.
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

  // ---------- Sessions and tabs ----------
  sessions = new SessionManager(createSessionSetup({
    rendererDir: RENDERER_DIR,
    recording,
    getFolder: getRecordingFolder,
    blocker,
    blockingActiveFor,
    getTabs: () => tabs,
    downloads,
    notify,
    downloadDir: options.downloadDir,
    downloadSaveName: options.downloadSaveName,
    permissionLog,
    certificates,
    cookieClock,
  }));
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
    onBlocked: (_target, reason) => {
      if (reason !== 'empty') notify(BLOCK_MESSAGES[reason] ?? BLOCK_MESSAGES['blocked-scheme'], 'warning');
    },
    onInput: trackInput,
  });
  idle = new FullscreenIdle({ host, tabs, idleMs: options.idleMs });

  // Right-click menus: full menu in web pages, only edit commands in the browser's own text boxes.
  const edit = (contents) => (name) => { if (EDIT_COMMANDS.has(name)) contents[name](); };
  // A saved video or sound is marked as one on the Downloads page.
  const saveMedia = (contents, url, kind) => {
    downloads.expect(url, { kind });
    contents.downloadURL(url);
  };
  tabs.on('created', (tab) => {
    const contents = tab.view.webContents;
    videoFinder.watch(tab);
    attachContextMenu(contents, win, () => ({
      openInNewTab: (url) => tabs.create({ url, isPrivate: tab.isPrivate }),
      copyText: (text) => clipboard.writeText(text),
      saveImage: (url) => contents.downloadURL(url),
      saveMedia: (url, kind) => saveMedia(contents, url, kind),
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
    // A new page: what it asks for is its own.
    if (!inPage) permissionLog.clear(tab.view.webContents.id);
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
    recording.onTabActivated(id);
  });

  // Sleep or shut down once downloads finish. Tests pass their own `powerAction`.
  const runPowerAction = options.powerAction ?? ((action) => {
    const { execFile } = require('node:child_process');
    const quiet = { windowsHide: true };
    if (action === 'shutdown') execFile('shutdown.exe', ['/s', '/t', '0'], quiet);
    else if (action === 'sleep') {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        "Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.Application]::SetSuspendState('Suspend', $false, $false)"], quiet);
    }
  });
  const whenDone = new WhenDone({ downloads, run: runPowerAction, notify: (text, kind) => notify(text, kind), countdownMs: options.whenDoneCountdownMs });
  whenDone.on('change', (state) => broadcastToLibrary('downloads:when-done', state));

  let downloadTimer = null;
  downloads.on('started', (entry) => notify(`Downloading ${entry.filename}…`));
  downloads.on('completed', (entry) => {
    // Marked (or not) before anything can open it.
    setInternetMark(entry.path, settings.data.markOfTheWeb);
    notify(`Download complete: ${entry.filename}`);
    if (entry.openWhenDone) openDownload(entry.id);
  });
  downloads.on('change', () => {
    if (downloadTimer) return;
    downloadTimer = setTimeout(() => {
      downloadTimer = null;
      broadcastToLibrary('downloads:changed', downloads.list());
      if (isLive(ui.webContents)) ui.webContents.send('downloads:brief', downloads.brief());
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

  // A finished download opens in its own app; the blocked file types never get this far, but
  // the name is checked again in case the file was swapped for one.
  const openDownload = async (id) => {
    const entry = downloads.entry(id);
    if (!entry || entry.state !== 'completed' || entry.missing || !entry.path || isDangerousFile(entry.path)) return false;
    return (await shell.openPath(entry.path)) === '';
  };

  // ---------- Actions shared by keyboard shortcuts, menus and the interface ----------
  const actions = {
    ...createBookmarkActions({
      settings, bookmarkIcons, keepBookmarkIcons, tabs, host, ui, win, dialog: appDialog, clipboard, notify, pushState, broadcastToLibrary,
    }),
    ...createPageActions({
      tabs, host, zoom, dialog: appDialog, win, documentsDir: () => app.getPath('documents'), getRecordingFolder, notify, pushState, broadcastToLibrary,
    }),
    ...recording.actions,
  };

  shortcutHandler = createShortcutHandler({ tabs, host, ui, actions });
  for (const view of [ui, indicator, find]) trackInput(view.webContents);

  // ---------- IPC ----------
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
    ui, find, actions, notify, pushState, buildState, getRecordingFolder, broadcastToLibrary, videoFinder, openDownload, saveMedia, clipboard,
    whenDone, defaultDownloadDir, downloadFolders, fetchIn, permissionLog, certificates, cookieClock, blockingActiveFor,
    regularSession: () => sessions.ensure(REGULAR_PARTITION),
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

  // ---------- Closing ----------
  // A running recording is stopped through the toolbar first, so its last second is kept.
  let closing = false;
  win.on('close', (event) => {
    saveSession();
    history.flush();
    bookmarkIcons.flush();
    downloads.shutdown();
    cookieClock.save();
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
    tabs.shutdown();
    const pages = [ui, indicator, find, ...[...tabs.tabs.values()].map((tab) => tab.view)].map((view) => view.webContents);
    for (const contents of pages) {
      if (contents && !contents.isDestroyed()) contents.close();
    }
    if (options.quitOnClose !== false) app.quit();
  });

  // ---------- First tabs ----------
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
    // Downloads that were running when the browser closed go on where they stopped.
    const resumed = settings.data.resumeDownloads ? downloads.resumeSaved() : 0;
    downloads.pump(); // links added to the queue last time
    if (resumed) notify(`Picking up ${resumed} download${resumed === 1 ? '' : 's'} from last time.`);
    else if (savedDownloads) notify(`${savedDownloads} unfinished download${savedDownloads === 1 ? ' is' : 's are'} paused on the Downloads page.`);
  });

  return {
    app, host, tabs, recorder, settings, history, downloads, recordingsIndex, zoom,
    ui, indicator, find, win, idle, actions, saveSession, stopCapture, updates, bookmarkIcons, videoFinder, whenDone,
    permissionLog, certificates, cookieClock, sessions,
  };
}

module.exports = { start, prepare };
