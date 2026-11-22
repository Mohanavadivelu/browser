'use strict';

const { EventEmitter } = require('node:events');
const { WebContentsView } = require('electron');
const { contentPreferences } = require('./sandbox/web-preferences');
const { attachNavigationGuards, isAllowedUrl, resolveInput } = require('./security/navigation');
const { isCertificateError } = require('./security/certificates');

// One sandboxed view per tab. Regular tabs share a saved profile; private tabs are isolated.
class TabManager extends EventEmitter {
  constructor({ host, sessions, newTabPage, warningPage, onBlocked, onInput }) {
    super();
    this.host = host;
    this.sessions = sessions;
    this.newTabPage = newTabPage;
    this.warningPage = warningPage;
    this.onBlocked = onBlocked;
    this.onInput = onInput;
    this.tabs = new Map();
    this.order = [];
    this.activeId = null;
    this.nextId = 1;
  }

  create({ url, isPrivate = false, activate = true } = {}) {
    const id = this.nextId++;
    const partition = this.sessions.partitionFor(id, isPrivate);
    this.sessions.ensure(partition);
    const view = new WebContentsView({ webPreferences: contentPreferences(partition) });
    view.setBackgroundColor('#ffffff');
    view.setVisible(false);

    const tab = { id, view, isPrivate, title: '', favicon: '', loading: false };
    this.tabs.set(id, tab);
    this.order.push(id);
    this.host.addContentView(view);
    this.wire(tab);

    if (url && isAllowedUrl(url)) view.webContents.loadURL(url).catch(() => {});
    else view.webContents.loadFile(this.newTabPage);

    if (activate || this.activeId === null) this.activate(id);
    this.emit('change');
    return tab;
  }

  wire(tab) {
    const contents = tab.view.webContents;
    const changed = () => this.emit('change');

    attachNavigationGuards(contents, {
      openInNewTab: (url) => this.create({ url, isPrivate: tab.isPrivate }),
      onBlocked: this.onBlocked,
    });
    this.onInput(contents);

    contents.on('did-start-loading', () => { tab.loading = true; changed(); });
    contents.on('did-stop-loading', () => { tab.loading = false; changed(); });
    contents.on('did-navigate', changed);
    contents.on('did-navigate-in-page', changed);
    contents.on('page-title-updated', (_event, title) => { tab.title = title; changed(); });
    contents.on('page-favicon-updated', (_event, favicons) => {
      tab.favicon = favicons.find((icon) => icon.startsWith('https:')) ?? '';
      changed();
    });
    contents.on('did-fail-load', (_event, code, _description, url, isMainFrame) => {
      if (isMainFrame && isCertificateError(code)) {
        contents.loadFile(this.warningPage, { query: { url, code: String(code) } });
      }
    });
    contents.on('enter-html-full-screen', () => this.host.setHtmlFullscreen(true));
    contents.on('leave-html-full-screen', () => this.host.setHtmlFullscreen(false));
    contents.on('render-process-gone', (_event, details) => {
      console.error(`Tab ${tab.id} renderer gone: ${details.reason}`);
    });
  }

  get active() {
    return this.tabs.get(this.activeId) ?? null;
  }

  activate(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    this.activeId = id;
    for (const other of this.tabs.values()) other.view.setVisible(other === tab);
    tab.view.webContents.focus();
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
    this.order.splice(index, 1);
    this.tabs.delete(id);
    this.host.removeContentView(tab.view);
    tab.view.webContents.close();
    if (tab.isPrivate) this.sessions.releasePrivate(id).catch((error) => console.error(error));

    if (this.order.length === 0) {
      this.activeId = null;
      this.create();
      return;
    }
    if (this.activeId === id) this.activate(this.order[Math.min(index, this.order.length - 1)]);
    this.emit('change');
  }

  navigate(input) {
    const resolved = resolveInput(input);
    if (!resolved.ok) {
      this.onBlocked(String(input), resolved.reason);
      return resolved;
    }
    this.active?.view.webContents.loadURL(resolved.url).catch(() => {});
    return resolved;
  }

  goHome() {
    this.active?.view.webContents.loadFile(this.newTabPage);
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

  stop() {
    this.active?.view.webContents.stop();
  }

  snapshot() {
    return this.order.map((id) => {
      const tab = this.tabs.get(id);
      const contents = tab.view.webContents;
      const url = contents.getURL();
      return {
        id,
        title: tab.title || (url.startsWith('file:') ? 'New tab' : url),
        url: url.startsWith('file:') ? '' : url,
        favicon: tab.favicon,
        loading: tab.loading,
        isPrivate: tab.isPrivate,
        canGoBack: contents.navigationHistory.canGoBack(),
        canGoForward: contents.navigationHistory.canGoForward(),
      };
    });
  }
}

module.exports = { TabManager };
