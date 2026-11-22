'use strict';

// Sandboxed preload: the only bridge between the browser chrome and the main process.
// Every call is an invoke on a fixed channel name; the main process validates each one.
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('browserApi', {
  getState: () => invoke('ui:get-state'),
  tabs: {
    create: (options) => (options ? invoke('tabs:create', options) : invoke('tabs:create')),
    close: (id) => invoke('tabs:close', id),
    activate: (id) => invoke('tabs:activate', id),
  },
  nav: {
    go: (input) => invoke('nav:go', input),
    back: () => invoke('nav:back'),
    forward: () => invoke('nav:forward'),
    reload: () => invoke('nav:reload'),
    stop: () => invoke('nav:stop'),
    home: () => invoke('nav:home'),
  },
  window: {
    toggleFullscreen: () => invoke('window:toggle-fullscreen'),
    reveal: (revealed) => invoke('window:reveal', revealed),
    showMenu: () => invoke('window:menu'),
  },
  bookmarks: {
    toggle: () => invoke('bookmarks:toggle'),
  },
  recording: {
    requestStart: () => invoke('recording:request-start'),
    requestStop: () => invoke('recording:request-stop'),
    chunk: (data) => invoke('recording:chunk', data),
    finish: () => invoke('recording:finish'),
    abort: () => invoke('recording:abort'),
  },
  onState: (callback) => subscribe('ui:state', callback),
  onNotice: (callback) => subscribe('ui:notice', callback),
  onFocusAddress: (callback) => subscribe('ui:focus-address', callback),
  onRecordingCommand: (callback) => subscribe('recording:command', callback),
});
