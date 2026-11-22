'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const {
  app, ipcMain, session, shell, dialog, Menu, desktopCapturer, webContents,
} = require('electron');
const { BrowserWindow } = require('./window');
const { TabManager } = require('./tabs');
const { SessionManager, UI_PARTITION } = require('./sandbox/session-manager');
const { applyPermissionPolicy } = require('./security/permissions');
const { attachDownloadPolicy } = require('./security/downloads');
const { isAllowedUrl } = require('./security/navigation');
const { createIpc, validators } = require('./security/ipc-validate');
const { Recorder } = require('./recording/recorder');
const { askRecordingConsent } = require('./recording/consent');
const { Settings } = require('./storage/settings');
const { createShortcutHandler } = require('./shortcuts');

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const PRELOAD_PATH = path.join(__dirname, '..', 'preload', 'preload.js');

const BLOCK_MESSAGES = {
  'blocked-scheme': 'Blocked: only http and https addresses can be opened.',
  'too-long': 'That address is too long.',
};

function cleanUserAgent(userAgent) {
  return userAgent.replace(/\s?Electron\/\S+/, '').replace(/\s?simple-browser\/\S+/i, '');
}

async function start(options = {}) {
  app.enableSandbox();
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

  const settings = new Settings(path.join(app.getPath('userData'), 'settings.json'));
  settings.load();

  const host = new BrowserWindow({ rendererDir: RENDERER_DIR, preloadPath: PRELOAD_PATH });
  const { win, ui, indicator } = host;

  let tabs;
  let pushScheduled = false;
  const buildState = () => ({
    tabs: tabs.snapshot(),
    activeId: tabs.activeId,
    fullscreen: host.mode.fullscreen,
    htmlFullscreen: host.mode.htmlFullscreen,
    revealed: host.mode.revealed,
    recording: recorder.info,
    bookmarks: settings.data.bookmarks,
  });
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

  const recorder = new Recorder({
    getFolder: () => settings.data.recordingFolder ?? path.join(app.getPath('videos'), 'Simple Browser'),
    requestConsent: options.autoConsent ? async () => ({ granted: true }) : () => askRecordingConsent(win),
    onChange: () => {
      host.setRecording(recorder.active);
      pushState();
    },
    notify,
  });

  const onBlocked = (_target, reason) => {
    if (reason === 'empty') return;
    notify(BLOCK_MESSAGES[reason] ?? BLOCK_MESSAGES['blocked-scheme'], 'warning');
  };

  const configureSession = (ses, kind) => {
    if (kind === 'ui') {
      // The chrome view may ask for screen capture, but the handler below only grants it
      // right after the consent dialog.
      applyPermissionPolicy(ses, new Set(['display-capture']));
      ses.setDisplayMediaRequestHandler(async (request, callback) => {
        const requester = request.frame ? webContents.fromFrame(request.frame) : null;
        const allowed = requester?.id === ui.webContents.id && recorder.consumeAuthorization();
        const sources = allowed ? await desktopCapturer.getSources({ types: ['window'] }) : [];
        const source = sources.find((candidate) => candidate.id === win.getMediaSourceId());
        callback(source ? { video: source } : {});
      }, { useSystemPicker: false });
      return;
    }
    applyPermissionPolicy(ses);
    attachDownloadPolicy(ses, {
      onBlocked: (name) => notify(`Blocked download of "${name}": executable files are not allowed.`, 'warning'),
    });
    ses.setUserAgent(cleanUserAgent(ses.getUserAgent()));
  };
  const sessions = new SessionManager(configureSession);
  sessions.ensure(UI_PARTITION, 'ui');

  let shortcutHandler = () => {};
  tabs = new TabManager({
    host,
    sessions,
    newTabPage: path.join(RENDERER_DIR, 'newtab.html'),
    warningPage: path.join(RENDERER_DIR, 'warning.html'),
    onBlocked,
    onInput: (contents) => contents.on('before-input-event', (event, input) => shortcutHandler(event, input)),
  });

  const toggleBookmark = () => {
    const tab = tabs.active;
    if (!tab) return;
    if (tab.isPrivate) {
      notify('Bookmarks are not saved from private tabs.', 'warning');
      return;
    }
    const url = tab.view.webContents.getURL();
    if (!isAllowedUrl(url)) return;
    const current = settings.data.bookmarks;
    const exists = current.some((bookmark) => bookmark.url === url);
    settings.update({
      bookmarks: exists
        ? current.filter((bookmark) => bookmark.url !== url)
        : [...current, { url, title: tab.title || url }],
    });
    notify(exists ? 'Bookmark removed.' : 'Bookmark added.');
    pushState();
  };

  shortcutHandler = createShortcutHandler({ tabs, host, ui, actions: { toggleBookmark } });
  ui.webContents.on('before-input-event', (event, input) => shortcutHandler(event, input));

  const rendererUrl = pathToFileURL(RENDERER_DIR).href;
  const trustedIds = () => new Set([ui.webContents.id, indicator.webContents.id]);
  const isTrustedSender = (event) =>
    trustedIds().has(event.sender.id) &&
    event.senderFrame === event.sender.mainFrame &&
    event.senderFrame.url.startsWith(rendererUrl);
  const ipc = createIpc(ipcMain, isTrustedSender);

  const showMenu = () => {
    const recording = recorder.active;
    Menu.buildFromTemplate([
      { label: 'New tab', accelerator: 'Ctrl+T', click: () => tabs.create() },
      { label: 'New private tab', accelerator: 'Ctrl+Shift+N', click: () => tabs.create({ isPrivate: true }) },
      { type: 'separator' },
      {
        label: recording ? 'Stop recording' : 'Record this window…',
        click: () => ui.webContents.send('recording:command', recording ? 'stop' : 'start'),
      },
      {
        label: 'Choose recording folder…',
        click: async () => {
          const result = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
          if (!result.canceled && result.filePaths[0]) {
            settings.update({ recordingFolder: result.filePaths[0] });
            notify('Recording folder updated.');
          }
        },
      },
      {
        label: 'Open recordings folder',
        click: () => {
          const folder = settings.data.recordingFolder ?? path.join(app.getPath('videos'), 'Simple Browser');
          require('node:fs').mkdirSync(folder, { recursive: true });
          shell.openPath(folder);
        },
      },
      { type: 'separator' },
      { label: 'Full screen', accelerator: 'F11', click: () => host.toggleFullscreen() },
      { type: 'separator' },
      {
        label: 'About Simple Browser',
        click: () => dialog.showMessageBox(win, {
          type: 'info',
          title: 'About',
          message: `Simple Browser ${app.getVersion()}`,
          detail: `Electron ${process.versions.electron}\nChromium ${process.versions.chrome}`,
        }),
      },
    ]).popup({ window: win });
  };

  const { none, tabId, text, bool, tabOptions, chunk } = validators;
  ipc.handle('ui:get-state', none, () => buildState());
  ipc.handle('tabs:create', tabOptions, (_e, opts = {}) => { tabs.create({ isPrivate: opts.private === true }); });
  ipc.handle('tabs:close', tabId, (_e, id) => tabs.close(id));
  ipc.handle('tabs:activate', tabId, (_e, id) => tabs.activate(id));
  ipc.handle('nav:go', text, (_e, input) => tabs.navigate(input).ok);
  ipc.handle('nav:back', none, () => tabs.back());
  ipc.handle('nav:forward', none, () => tabs.forward());
  ipc.handle('nav:reload', none, () => tabs.reload());
  ipc.handle('nav:stop', none, () => tabs.stop());
  ipc.handle('nav:home', none, () => tabs.goHome());
  ipc.handle('window:toggle-fullscreen', none, () => host.toggleFullscreen());
  ipc.handle('window:reveal', bool, (_e, revealed) => host.setRevealed(revealed));
  ipc.handle('window:menu', none, () => showMenu());
  ipc.handle('bookmarks:toggle', none, () => toggleBookmark());
  ipc.handle('recording:request-start', none, () => recorder.requestStart());
  ipc.handle('recording:chunk', chunk, (_e, data) => recorder.write(data));
  ipc.handle('recording:request-stop', none, () => ui.webContents.send('recording:command', 'stop'));
  ipc.handle('recording:finish', none, async () => {
    const filePath = await recorder.finish();
    if (filePath) notify(`Recording saved: ${filePath}`);
    return filePath;
  });
  ipc.handle('recording:abort', none, async () => {
    await recorder.abort();
    notify('Recording could not start.', 'error');
  });

  host.on('mode-change', pushState);
  tabs.on('change', pushState);

  win.on('close', (event) => {
    if (!recorder.active) return;
    event.preventDefault();
    recorder.finish().then(() => win.close());
  });
  win.on('closed', () => app.quit());

  tabs.create();
  ui.webContents.once('did-finish-load', () => {
    host.layout();
    win.show();
    pushState();
  });

  return { app, host, tabs, recorder, settings, ui, indicator, win, session };
}

module.exports = { start };
