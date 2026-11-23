'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { validators } = require('./security/ipc-validate');
const { isAllowedUrl, SEARCH_ENGINES } = require('./security/navigation');
const { pickEditable } = require('./storage/settings');
const { publicQualities } = require('./recording/quality');
const {
  isSafeName, listRecordings, renameRecording, deleteRecording,
} = require('./recording/library');

// Every call from the browser's own pages comes through here. The sender and the arguments
// are validated by `ipc.handle` before any handler runs.
function registerIpcHandlers(ipc, ctx) {
  const {
    shell, dialog, host, tabs, recorder, settings, history, downloads, recordingsIndex,
    ui, find, actions, notify, pushState, buildState, getRecordingFolder, broadcastToLibrary, showMenu,
  } = ctx;
  const {
    none, tabId, text, optionalText, twoTexts, bool, settingsPatch, findQuery, tabOptions, chunk,
  } = validators;

  const settingsPayload = () => ({
    ...pickEditable(settings.data),
    recordingFolder: getRecordingFolder(),
    engines: Object.entries(SEARCH_ENGINES).map(([key, engine]) => ({ key, name: engine.name })),
    qualities: publicQualities(),
  });

  // Tabs and navigation
  ipc.handle('ui:get-state', none, () => buildState());
  ipc.handle('tabs:create', tabOptions, (_e, opts = {}) => { tabs.create({ isPrivate: opts.private === true }); });
  ipc.handle('tabs:close', tabId, (_e, id) => tabs.close(id));
  ipc.handle('tabs:activate', tabId, (_e, id) => tabs.activate(id));
  ipc.handle('tabs:open', text, (_e, url) => { if (isAllowedUrl(url)) tabs.create({ url }); });
  ipc.handle('nav:go', text, (_e, input) => tabs.navigate(input).ok);
  ipc.handle('nav:back', none, () => tabs.back());
  ipc.handle('nav:forward', none, () => tabs.forward());
  ipc.handle('nav:reload', none, () => tabs.reload());
  ipc.handle('nav:stop', none, () => tabs.stop());
  ipc.handle('nav:home', none, () => tabs.goHome());
  ipc.handle('window:toggle-fullscreen', none, () => host.toggleFullscreen());
  ipc.handle('window:reveal', bool, (_e, revealed) => host.setRevealed(revealed));
  ipc.handle('window:menu', none, () => showMenu());
  ipc.handle('bookmarks:toggle', none, () => actions.toggleBookmark());
  ipc.handle('zoom:reset', none, () => actions.zoom(0));

  // Find in page
  ipc.handle('find:query', findQuery, (_e, query, options) => {
    const contents = tabs.active?.view.webContents;
    if (!contents) return;
    if (!query) {
      contents.stopFindInPage('clearSelection');
      find.webContents.send('find:result', { active: 0, matches: 0 });
      return;
    }
    contents.findInPage(query, { forward: options.forward !== false, findNext: options.next === true, matchCase: false });
  });
  ipc.handle('find:close', none, () => host.closeFind());

  // Settings
  ipc.handle('settings:get', none, () => settingsPayload());
  ipc.handle('settings:update', settingsPatch, (_e, patch) => {
    settings.update(pickEditable(patch));
    if (!settings.data.restoreTabs) settings.update({ session: { urls: [], active: 0 } });
    pushState();
    return settingsPayload();
  });
  ipc.handle('settings:choose-folder', none, async () => {
    const result = await dialog.showOpenDialog(host.win, {
      title: 'Choose the recordings folder',
      defaultPath: getRecordingFolder(),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (!result.canceled && result.filePaths[0]) settings.update({ recordingFolder: result.filePaths[0] });
    return settingsPayload();
  });

  // History
  ipc.handle('history:list', optionalText, (_e, query = '') => ({
    enabled: settings.data.historyEnabled,
    entries: history.list(query),
  }));
  ipc.handle('history:remove', tabId, (_e, id) => history.remove(id));
  ipc.handle('history:clear', none, () => { history.clear(); });

  // Downloads
  ipc.handle('downloads:list', none, () => downloads.list());
  ipc.handle('downloads:cancel', tabId, (_e, id) => downloads.cancel(id));
  ipc.handle('downloads:show', tabId, (_e, id) => {
    const filePath = downloads.pathOf(id);
    if (filePath && fs.existsSync(filePath)) shell.showItemInFolder(filePath);
  });

  // Recordings and screenshots
  const recordingPath = (name) => (isSafeName(getRecordingFolder(), name) ? path.join(getRecordingFolder(), name) : null);
  ipc.handle('recordings:list', none, () => ({
    folder: getRecordingFolder(),
    entries: listRecordings(getRecordingFolder(), recordingsIndex),
  }));
  ipc.handle('recordings:open', text, async (_e, name) => {
    const target = recordingPath(name);
    if (!target || !fs.existsSync(target)) return false;
    return (await shell.openPath(target)) === '';
  });
  ipc.handle('recordings:reveal', text, (_e, name) => {
    const target = recordingPath(name);
    if (target && fs.existsSync(target)) shell.showItemInFolder(target);
  });
  ipc.handle('recordings:rename', twoTexts, (_e, name, newName) => {
    const result = renameRecording(getRecordingFolder(), name, newName, recordingsIndex);
    if (result.ok) broadcastToLibrary('recordings:changed');
    return result;
  });
  ipc.handle('recordings:delete', text, async (_e, name) => {
    const result = await deleteRecording(getRecordingFolder(), name, (target) => shell.trashItem(target), recordingsIndex);
    if (result.ok) broadcastToLibrary('recordings:changed');
    return result;
  });
  ipc.handle('recordings:open-folder', none, async () => {
    fs.mkdirSync(getRecordingFolder(), { recursive: true });
    await shell.openPath(getRecordingFolder());
  });
  ipc.handle('screenshot:take', none, () => actions.screenshot());

  // Recording control
  ipc.handle('recording:request-start', none, async () => {
    const result = await recorder.requestStart();
    return result.ok ? { ...result, quality: settings.data.recordingQuality } : result;
  });
  ipc.handle('recording:chunk', chunk, (_e, data) => recorder.write(data));
  ipc.handle('recording:request-stop', none, () => ui.webContents.send('recording:command', 'stop'));
  ipc.handle('recording:request-pause', none, () => actions.togglePause());
  ipc.handle('recording:set-paused', bool, (_e, paused) => recorder.setPaused(paused));
  ipc.handle('recording:rollover', none, async () => {
    const result = await recorder.rollover();
    return result.ok ? { ...result, quality: settings.data.recordingQuality } : result;
  });
  ipc.handle('recording:reauthorize', none, () => ({ ok: recorder.authorizeCapture() }));
  ipc.handle('recording:finish', none, () => recorder.finish());
  ipc.handle('recording:abort', none, async () => {
    await recorder.abort();
    notify('Recording could not start.', 'error');
  });
}

module.exports = { registerIpcHandlers };
