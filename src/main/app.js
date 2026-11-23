'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, ipcMain, shell, dialog, Menu, clipboard, webContents } = require('electron');
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
  const zoom = new ZoomController({ settings });

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
      shortcutHandler(event, input);
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
  tabs.on('navigated', (tab, url) => {
    if (shouldRecordHistory(tab)) history.add({ url, title: tab.title });
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

  const rendererUrl = pathToFileURL(RENDERER_DIR).href;
  const isTrustedSender = (event) => {
    const trusted = new Set([ui, indicator, find].map((view) => view.webContents.id));
    for (const contents of tabs.internalContents()) trusted.add(contents.id);
    return trusted.has(event.sender.id) &&
      event.senderFrame === event.sender.mainFrame &&
      event.senderFrame.url.startsWith(rendererUrl);
  };
  const ipc = createIpc(ipcMain, isTrustedSender);

  const context = {
    app, shell, dialog, host, tabs, recorder, settings, history, downloads, recordingsIndex, zoom,
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
    host.layout();
    win.show();
    pushState();
  });

  return {
    app, host, tabs, recorder, settings, history, downloads, recordingsIndex, zoom,
    ui, indicator, find, win, idle, actions, saveSession, stopCapture,
  };
}

module.exports = { start };
