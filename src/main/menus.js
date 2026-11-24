'use strict';

const { Menu } = require('electron');

// The ⋮ menu. Pages cannot open or change it.
function showMainMenu(ctx) {
  const { app, dialog, host, tabs, recorder, actions, shell, getRecordingFolder } = ctx;
  const recording = recorder.active;
  const items = [
    { label: 'New tab', accelerator: 'Ctrl+T', click: () => tabs.create() },
    { label: 'New private tab', accelerator: 'Ctrl+Shift+N', click: () => tabs.create({ isPrivate: true }) },
    { label: 'Reopen closed tab', accelerator: 'Ctrl+Shift+T', enabled: tabs.closed.length > 0, click: () => tabs.reopenClosed() },
    { type: 'separator' },
    { label: 'Find in page…', accelerator: 'Ctrl+F', click: () => actions.find() },
    {
      label: 'Zoom',
      submenu: [
        { label: 'Zoom in', accelerator: 'Ctrl+Plus', click: () => actions.zoom(1) },
        { label: 'Zoom out', accelerator: 'Ctrl+-', click: () => actions.zoom(-1) },
        { label: 'Reset zoom', accelerator: 'Ctrl+0', click: () => actions.zoom(0) },
      ],
    },
    { type: 'separator' },
    { label: 'History', accelerator: 'Ctrl+H', click: () => actions.openLibrary('history') },
    { label: 'Bookmarks', accelerator: 'Ctrl+Shift+O', click: () => actions.openLibrary('bookmarks') },
    { label: 'Downloads', accelerator: 'Ctrl+J', click: () => actions.openLibrary('downloads') },
    { label: 'Recordings', click: () => actions.openLibrary('recordings') },
    { label: 'Settings', click: () => actions.openLibrary('settings') },
    { type: 'separator' },
    {
      label: recording ? 'Stop recording' : 'Record this page…',
      accelerator: 'Ctrl+Shift+E',
      click: () => actions.toggleRecording(),
    },
    ...(recording
      ? [{ label: recorder.paused ? 'Resume recording' : 'Pause recording', accelerator: 'Ctrl+Shift+P', click: () => actions.togglePause() }]
      : []),
    { label: 'Screenshot of this page', accelerator: 'Ctrl+Shift+S', click: () => actions.screenshot() },
    {
      label: 'Open recordings folder',
      click: () => {
        require('node:fs').mkdirSync(getRecordingFolder(), { recursive: true });
        shell.openPath(getRecordingFolder());
      },
    },
    { type: 'separator' },
    { label: 'Full screen', accelerator: 'F11', click: () => host.toggleFullscreen() },
    { type: 'separator' },
    {
      label: 'About Simple Browser',
      click: () => dialog.showMessageBox(host.win, {
        type: 'info',
        title: 'About',
        message: `Simple Browser ${app.getVersion()}`,
        detail: `Electron ${process.versions.electron}\nChromium ${process.versions.chrome}`,
      }),
    },
  ];
  Menu.buildFromTemplate(items).popup({ window: host.win });
}

module.exports = { showMainMenu };
