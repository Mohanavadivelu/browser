'use strict';

// Sandboxed preload: the only bridge between the browser's own pages and the main process.
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
    open: (url) => invoke('tabs:open', url),
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
  zoom: {
    reset: () => invoke('zoom:reset'),
  },
  find: {
    query: (text, options) => invoke('find:query', text, options),
    close: () => invoke('find:close'),
  },
  settings: {
    get: () => invoke('settings:get'),
    update: (patch) => invoke('settings:update', patch),
    chooseFolder: () => invoke('settings:choose-folder'),
  },
  history: {
    list: (query) => (query ? invoke('history:list', query) : invoke('history:list')),
    remove: (id) => invoke('history:remove', id),
    clear: () => invoke('history:clear'),
  },
  downloads: {
    list: () => invoke('downloads:list'),
    cancel: (id) => invoke('downloads:cancel', id),
    show: (id) => invoke('downloads:show', id),
  },
  recordings: {
    list: () => invoke('recordings:list'),
    open: (name) => invoke('recordings:open', name),
    reveal: (name) => invoke('recordings:reveal', name),
    rename: (name, newName) => invoke('recordings:rename', name, newName),
    delete: (name) => invoke('recordings:delete', name),
    openFolder: () => invoke('recordings:open-folder'),
  },
  screenshot: () => invoke('screenshot:take'),
  recording: {
    requestStart: () => invoke('recording:request-start'),
    requestStop: () => invoke('recording:request-stop'),
    requestPause: () => invoke('recording:request-pause'),
    setPaused: (paused) => invoke('recording:set-paused', paused),
    rollover: () => invoke('recording:rollover'),
    reauthorize: () => invoke('recording:reauthorize'),
    chunk: (data) => invoke('recording:chunk', data),
    finish: () => invoke('recording:finish'),
    abort: () => invoke('recording:abort'),
  },
  onState: (callback) => subscribe('ui:state', callback),
  onNotice: (callback) => subscribe('ui:notice', callback),
  onFocusAddress: (callback) => subscribe('ui:focus-address', callback),
  onRecordingCommand: (callback) => subscribe('recording:command', callback),
  onFindResult: (callback) => subscribe('find:result', callback),
  onFindFocus: (callback) => subscribe('find:focus', callback),
  onDownloads: (callback) => subscribe('downloads:changed', callback),
  onRecordingsChanged: (callback) => subscribe('recordings:changed', callback),
  onLibraryShow: (callback) => subscribe('library:show', callback),
});
