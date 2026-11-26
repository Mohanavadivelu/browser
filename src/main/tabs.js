'use strict';

const { EventEmitter } = require('node:events');
const { WebContentsView } = require('electron');
const { contentPreferences, uiPreferences } = require('./sandbox/web-preferences');
const {
  attachNavigationGuards, isAllowedUrl, resolveInput, internalUrl,
} = require('./security/navigation');
const { isCertificateError } = require('./security/certificates');
const { appUrl, isAppUrl } = require('./app-scheme');
const { BlockedLog } = require('./blocker');

const MAX_CLOSED = 25;

// One sandboxed view per tab. Regular tabs share a saved profile; private tabs are isolated.
// "Internal" tabs show the app's own History / Downloads / Recordings / Settings pages.
class TabManager extends EventEmitter {
  constructor({
    host, sessions, newTabPage, warningPage, libraryPage, preloadPath, zoom,
    getEngine, getHome, onBlocked, onInput, fetchFavicon = require('./favicons').fetchFavicon,
  }) {
    super();
    this.fetchFavicon = fetchFavicon;
    this.host = host;
    this.sessions = sessions;
    this.newTabPage = newTabPage;
    this.warningPage = warningPage;
    this.libraryPage = libraryPage;
    this.preloadPath = preloadPath;
    this.zoom = zoom;
    this.getEngine = getEngine;
    this.getHome = getHome;
    this.onBlocked = onBlocked;
    this.onInput = onInput;
    this.tabs = new Map();
    this.order = [];
    // Regular web pages closed recently, newest last, for "Reopen closed tab". Private tabs
    // are never kept.
    this.closed = [];
    this.activeId = null;
    this.nextId = 1;
  }

  create({ url, isPrivate = false, activate = true, index } = {}) {
    const id = this.nextId++;
    const partition = this.sessions.partitionFor(id, isPrivate);
    this.sessions.ensure(partition);
    const view = new WebContentsView({ webPreferences: contentPreferences(partition) });
    view.setBackgroundColor('#ffffff');
    view.setVisible(false);

    const tab = { id, view, isPrivate, kind: 'web', title: '', favicon: '', loading: false };
    this.register(tab, index);
    this.wireCommon(tab);
    this.wireWeb(tab);
    this.emit('created', tab);

    if (url && isAllowedUrl(url)) view.webContents.loadURL(url).catch(() => {});
    else this.loadNewTabPage(view.webContents);

    if (activate || this.activeId === null) this.activate(id);
    this.emit('change');
    return tab;
  }

  loadNewTabPage(contents) {
    contents.loadURL(appUrl(this.newTabPage, { query: { engine: this.getEngine() } })).catch(() => {});
  }

  register(tab, index = this.order.length) {
    this.tabs.set(tab.id, tab);
    this.order.splice(Math.max(0, Math.min(index, this.order.length)), 0, tab.id);
    this.host.addContentView(tab.view);
  }

  // Opens (or switches the existing internal tab to) one of the app's own pages.
  openInternal(page) {
    const existing = [...this.tabs.values()].find((tab) => tab.kind === 'internal');
    if (existing) {
      existing.page = page;
      existing.view.webContents.send('library:show', page);
      this.activate(existing.id);
      return existing;
    }
    const id = this.nextId++;
    const view = new WebContentsView({ webPreferences: uiPreferences(this.preloadPath) });
    view.setBackgroundColor('#1a1b1e');
    view.setVisible(false);
    const tab = { id, view, isPrivate: false, kind: 'internal', page, title: '', favicon: '', loading: false };
    this.register(tab);
    this.wireCommon(tab);

    // These pages have the app bridge, so they must never leave the app's own files.
    const contents = view.webContents;
    contents.on('will-navigate', (event) => event.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.loadURL(appUrl(this.libraryPage, { hash: page })).catch(() => {});
    this.activate(id);
    this.emit('change');
    return tab;
  }

  wireCommon(tab) {
    const contents = tab.view.webContents;
    const changed = () => this.emit('change');
    this.onInput(contents);

    contents.on('did-start-loading', () => { tab.loading = true; changed(); });
    contents.on('did-stop-loading', () => { tab.loading = false; changed(); });
    contents.on('page-title-updated', (_event, title) => {
      tab.title = title;
      this.emit('titled', tab, contents.getURL(), title);
      changed();
    });
    // The icon is fetched here, through the tab's own session, and passed on as a data: URL.
    contents.on('page-favicon-updated', (_event, favicons) => {
      const source = favicons.find((icon) => isAllowedUrl(icon)) ?? '';
      tab.faviconSource = source;
      if (!source) {
        tab.favicon = '';
        changed();
        return;
      }
      this.fetchFavicon(contents.session, source).then((dataUrl) => {
        if (tab.faviconSource !== source || contents.isDestroyed()) return;
        tab.favicon = dataUrl;
        if (dataUrl) this.emit('favicon', tab, contents.getURL(), dataUrl);
        changed();
      });
    });
    contents.on('audio-state-changed', changed);
    contents.on('enter-html-full-screen', () => this.host.setHtmlFullscreen(true));
    contents.on('leave-html-full-screen', () => this.host.setHtmlFullscreen(false));
    contents.on('render-process-gone', (_event, details) => {
      console.error(`Tab ${tab.id} renderer gone: ${details.reason}`);
    });
  }

  wireWeb(tab) {
    const contents = tab.view.webContents;
    const changed = () => this.emit('change');

    attachNavigationGuards(contents, {
      openInNewTab: (url) => this.create({ url, isPrivate: tab.isPrivate }),
      onBlocked: this.onBlocked,
    });
    contents.on('did-navigate', (_event, url) => {
      tab.blocked = 0; // a new page: count and list its own blocked requests
      tab.blockedLog?.clear();
      this.zoom?.apply(tab);
      this.emit('navigated', tab, url);
      changed();
    });
    contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (isMainFrame) {
        this.zoom?.apply(tab);
        this.emit('navigated', tab, url, { inPage: true });
      }
      changed();
    });
    contents.on('did-fail-load', (_event, code, _description, url, isMainFrame) => {
      if (isMainFrame && isCertificateError(code)) {
        contents.loadURL(appUrl(this.warningPage, { query: { url, code: String(code) } })).catch(() => {});
      }
    });
    contents.on('zoom-changed', (_event, direction) => {
      this.zoom?.change(tab, direction === 'in' ? 1 : -1);
      changed();
    });
    contents.on('found-in-page', (_event, result) => this.emit('found', tab, result));
  }

  get active() {
    return this.tabs.get(this.activeId) ?? null;
  }

  internalContents() {
    return [...this.tabs.values()]
      .filter((tab) => tab.kind === 'internal' && !tab.view.webContents.isDestroyed())
      .map((tab) => tab.view.webContents);
  }

  activate(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    this.activeId = id;
    for (const other of this.tabs.values()) other.view.setVisible(other === tab);
    tab.view.webContents.focus();
    this.emit('activated', id);
    this.emit('change');
  }

  activateRelative(step) {
    if (this.order.length < 2) return;
    const index = this.order.indexOf(this.activeId);
    this.activate(this.order[(index + step + this.order.length) % this.order.length]);
  }

  close(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    const index = this.order.indexOf(id);
    const url = tab.view.webContents.getURL();
    if (tab.kind === 'web' && !tab.isPrivate && isAllowedUrl(url)) {
      this.closed.push({ url, index });
      if (this.closed.length > MAX_CLOSED) this.closed.shift();
    }
    this.order.splice(index, 1);
    this.tabs.delete(id);
    this.host.removeContentView(tab.view);
    tab.view.webContents.close();
    if (tab.isPrivate) this.sessions.releasePrivate(id).catch((error) => console.error(error));
    this.emit('closed', tab);

    if (this.order.length === 0) {
      this.activeId = null;
      this.create();
      return;
    }
    if (this.activeId === id) this.activate(this.order[Math.min(index, this.order.length - 1)]);
    this.emit('change');
  }

  // Opens the most recently closed regular page again, where its tab was. Null if none is left.
  reopenClosed() {
    const last = this.closed.pop();
    return last ? this.create({ url: last.url, index: last.index }) : null;
  }

  // Moves a tab to another place in the tab strip.
  move(id, index) {
    const from = this.order.indexOf(id);
    if (from === -1) return false;
    this.order.splice(from, 1);
    this.order.splice(Math.max(0, Math.min(index, this.order.length)), 0, id);
    this.emit('change');
    return true;
  }

  // One more ad or tracker request blocked in the tab showing `contentsId`; `request` (url,
  // resourceType, kind) goes into the tab's list for the shield's panel.
  countBlocked(contentsId, request) {
    for (const tab of this.tabs.values()) {
      if (tab.view.webContents.id !== contentsId) continue;
      tab.blocked = (tab.blocked ?? 0) + 1;
      if (request) (tab.blockedLog ??= new BlockedLog()).add(request);
      this.emit('change');
      return;
    }
  }

  toggleMute(id) {
    const contents = this.tabs.get(id)?.view.webContents;
    if (!contents || contents.isDestroyed()) return null;
    contents.setAudioMuted(!contents.isAudioMuted());
    this.emit('change');
    return contents.isAudioMuted();
  }

  // Address-bar input: internal pages open in their own tab; web addresses never load inside
  // an internal tab (those have the app bridge), so they open a new regular tab instead.
  navigate(input) {
    const resolved = resolveInput(input, this.getEngine());
    if (!resolved.ok) {
      this.onBlocked(String(input), resolved.reason);
      return resolved;
    }
    if (resolved.internal) this.openInternal(resolved.internal);
    else this.open(resolved.url);
    return resolved;
  }

  open(url) {
    const tab = this.active;
    if (!tab || tab.kind === 'internal') this.create({ url });
    else tab.view.webContents.loadURL(url).catch(() => {});
  }

  goHome() {
    const home = this.getHome();
    if (home) {
      this.open(home);
      return;
    }
    const tab = this.active;
    if (!tab || tab.kind === 'internal') this.create();
    else this.loadNewTabPage(tab.view.webContents);
  }

  back() {
    const history = this.active?.view.webContents.navigationHistory;
    if (history?.canGoBack()) history.goBack();
  }

  forward() {
    const history = this.active?.view.webContents.navigationHistory;
    if (history?.canGoForward()) history.goForward();
  }

  reload() {
    this.active?.view.webContents.reload();
  }

  // Reloads without the cache, like Ctrl+Shift+R in other browsers.
  reloadIgnoringCache() {
    this.active?.view.webContents.reloadIgnoringCache();
  }

  stop() {
    this.active?.view.webContents.stop();
  }

  snapshot() {
    return this.order.map((id) => {
      const tab = this.tabs.get(id);
      const contents = tab.view.webContents;
      const url = contents.getURL();
      const internal = tab.kind === 'internal';
      return {
        id,
        kind: tab.kind,
        title: tab.title || (internal ? 'Simple Browser' : isAppUrl(url) ? 'New tab' : url),
        url: internal ? internalUrl(tab.page) : isAppUrl(url) ? '' : url,
        favicon: tab.favicon,
        loading: tab.loading,
        isPrivate: tab.isPrivate,
        zoom: Math.round(contents.getZoomFactor() * 100) / 100,
        blocked: tab.blocked ?? 0,
        audible: contents.isCurrentlyAudible(),
        muted: contents.isAudioMuted(),
        canGoBack: contents.navigationHistory.canGoBack(),
        canGoForward: contents.navigationHistory.canGoForward(),
      };
    });
  }

  // Open regular web pages, for restoring the session on the next start.
  sessionSnapshot() {
    const urls = [];
    let active = 0;
    for (const id of this.order) {
      const tab = this.tabs.get(id);
      if (tab.kind !== 'web' || tab.isPrivate) continue;
      const url = tab.view.webContents.getURL();
      if (!isAllowedUrl(url)) continue;
      if (id === this.activeId) active = urls.length;
      urls.push(url);
    }
    return { urls, active };
  }
}

module.exports = { TabManager };
