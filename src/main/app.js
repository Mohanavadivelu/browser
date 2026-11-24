'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, ipcMain, shell, dialog, Menu, clipboard, webContents, net } = require('electron');
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
const { sanitizeBaseName } = require('./recording/library');
const { ContentBlocker, hostOf } = require('./blocker');
const { UpdateService, updateMode, fetchLatestRelease } = require('./updates');
const { build: { publish: [RELEASES] } } = require('../../package.json');
const { Settings } = require('./storage/settings');
const { History } = require('./storage/history');
const { DownloadManager } = require('./download-manager');
const { ZoomController } = require('./zoom');
const { createShortcutHandler } = require('./shortcuts');
const { FullscreenIdle } = require('./fullscreen-idle');
const { attachContextMenu } = require('./context-menu');
const { registerIpcHandlers } = require('./ipc-handlers');
const { showMainMenu } = require('./menus');

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const PRELOAD_PATH = path.join(__dirname, '..', 'preload', 'preload.js');
const SESSION_SAVE_DELAY_MS = 1000;
const DOWNLOAD_BROADCAST_MS = 200;
const BLOCKER_FIRST_UPDATE_MS = 10_000;
const BLOCKER_CHECK_MS = 6 * 60 * 60 * 1000;
// How long the toolbar gets to stop its capture and send the last chunks before the recording
// is closed without them.
const CAPTURE_STOP_TIMEOUT_MS = 3000;

const BLOCK_MESSAGES = {
  'blocked-scheme': 'Blocked: only http and https addresses can be opened.',
  'too-long': 'That address is too long.',
};
const EDIT_COMMANDS = new Set(['cut', 'copy', 'paste', 'selectAll']);

// A file name from the page title, without characters Windows forbids ("Q3: sales" -> "Q3 sales.pdf");
// pages without a usable title get "page.pdf".
function pdfFileName(title) {
  return `${sanitizeBaseName(title)?.replace(/\s+/g, ' ') ?? 'page'}.pdf`;
}

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
  if (!app.isReady()) app.enableSandbox();
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
  const host = new BrowserWindow({ rendererDir: RENDERER_DIR, preloadPath: PRELOAD_PATH });
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
    recording: recorder.info,
    recordingQuality: settings.data.recordingQuality,
    qualities: publicQualities(),
    bookmarks: settings.data.bookmarks,
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
      for (const view of [ui, indicator]) {
        if (!view.webContents.isDestroyed()) view.webContents.send('ui:state', state);
      }
    });
  };
  const notify = (text, kind = 'info') => {
    if (!ui.webContents.isDestroyed()) ui.webContents.send('ui:notice', { text, kind });
  };
  // The Downloads / Recordings / History / Settings pages live in internal tabs.
  const broadcastToLibrary = (channel, payload) => {
    for (const contents of tabs.internalContents()) contents.send(channel, payload);
  };

  recorder = new Recorder({
    getFolder: getRecordingFolder,
    requestConsent: options.autoConsent ? async () => ({ granted: true }) : () => askRecordingConsent(win),
    onChange: () => {
      host.setRecording(recorder.active);
      pushState();
    },
    notify,
    onFailure: () => { stopCapture(); },
    onSegment: (filePath, durationMs, final, { failed = false } = {}) => {
      if (recorder.removeIfEmpty(filePath)) {
        if (final && !failed) notify('The recording was empty and was not saved. Keep the page visible while recording.', 'error');
        return;
      }
      recordingsIndex.set(path.basename(filePath), durationMs);
      // After a write error the error notice stays up instead of a "saved" message.
      if (final && !failed) notify(`Recording saved: ${filePath}`);
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
      applyPermissionPolicy(ses, new Set(['display-capture']));
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
    newTabPage: path.join(RENDERER_DIR, 'newtab.html'),
    warningPage: path.join(RENDERER_DIR, 'warning.html'),
    libraryPage: path.join(RENDERER_DIR, 'library.html'),
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
      const current = settings.data.bookmarks;
      const exists = current.some((bookmark) => bookmark.url === url);
      settings.update({
        bookmarks: exists
          ? current.filter((bookmark) => bookmark.url !== url)
          : [...current, { url, title: tab.title || url }],
      });
      notify(exists ? 'Bookmark removed.' : 'Bookmark added.');
      broadcastToLibrary('bookmarks:changed');
      pushState();
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

  shortcutHandler = createShortcutHandler({ tabs, host, ui, actions });
  for (const view of [ui, indicator, find]) trackInput(view.webContents);

  // The trailing slash keeps a sibling folder such as "renderer-old" from matching.
  const rendererUrl = `${pathToFileURL(RENDERER_DIR).href}/`;
  // Which of the browser's own pages sent an IPC call, or null for anything else.
  const senderRole = (event) => {
    const frame = event.senderFrame;
    if (!frame || frame !== event.sender.mainFrame || !frame.url.startsWith(rendererUrl)) return null;
    const id = event.sender.id;
    if (id === ui.webContents.id) return 'toolbar';
    if (id === indicator.webContents.id) return 'indicator';
    if (id === find.webContents.id) return 'find';
    if (tabs.internalContents().some((contents) => contents.id === id)) return 'library';
    return null;
  };
  const ipc = createIpc(ipcMain, senderRole);

  const context = {
    app, shell, host, dialog: appDialog, blocker, refreshBlockerLists, updates, tabs, recorder, settings, history, downloads, recordingsIndex, zoom,
    ui, find, actions, notify, pushState, buildState, getRecordingFolder, broadcastToLibrary,
    showMenu: () => showMainMenu(context),
  };
  registerIpcHandlers(ipc, context);

  host.on('mode-change', pushState);
  tabs.on('change', pushState);

  // A running recording is stopped through the toolbar first, so its last second is kept.
  let closing = false;
  win.on('close', (event) => {
    saveSession();
    history.flush();
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
    ui, indicator, find, win, idle, actions, saveSession, stopCapture, updates,
  };
}

module.exports = { start, pdfFileName };
