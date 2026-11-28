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
const { isLive } = require('./live');

const MAX_CLOSED = 25;
// Tab groups: a name and one of these colours.
const { GROUP_COLORS } = require('./storage/settings');
const MAX_GROUP_NAME = 60;
// An isolated world for asking a page, before it sleeps, whether something was typed into it,
// and where it is scrolled to (to put it back there when it wakes).
const SLEEP_CHECK_WORLD = 1210;
const TYPED_CHECK = `(() => {
  const at = { x: Math.round(window.scrollX), y: Math.round(window.scrollY) };
  for (const field of document.querySelectorAll('input, textarea')) {
    if (field.type === 'hidden' || field.type === 'submit' || field.type === 'button') continue;
    if (field.type === 'checkbox' || field.type === 'radio' ? field.checked !== field.defaultChecked : field.value !== field.defaultValue) return { typed: true, ...at };
  }
  for (const box of document.querySelectorAll('[contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]')) {
    if (box.textContent.trim()) return { typed: true, ...at };
  }
  return { typed: false, ...at };
})()`;

// One sandboxed view per tab. Regular tabs share a saved profile; private tabs are isolated.
// "Internal" tabs show the app's own History / Downloads / Recordings / Settings pages.
class TabManager extends EventEmitter {
  constructor({
    host, sessions, newTabPage, warningPage, crashedPage = 'crashed.html', libraryPage, preloadPath, zoom,
    getEngine, getHome, onBlocked, onInput, fetchFavicon = require('./favicons').fetchFavicon,
  }) {
    super();
    this.fetchFavicon = fetchFavicon;
    this.host = host;
    this.sessions = sessions;
    this.newTabPage = newTabPage;
    this.warningPage = warningPage;
    this.crashedPage = crashedPage;
    this.libraryPage = libraryPage;
    this.preloadPath = preloadPath;
    this.zoom = zoom;
    this.getEngine = getEngine;
    this.getHome = getHome;
    this.onBlocked = onBlocked;
    this.onInput = onInput;
    this.tabs = new Map();
    this.order = [];
    this.groups = new Map();
    this.nextGroupId = 1;
    // Regular web pages closed recently, newest last, for "Reopen closed tab". Private tabs
    // are never kept.
    this.closed = [];
    this.activeId = null;
    this.nextId = 1;
  }

  create({ url, isPrivate = false, activate = true, index, pinned = false } = {}) {
    const id = this.nextId++;
    const view = this.newWebView(id, isPrivate);
    const tab = {
      id, view, isPrivate, kind: 'web', title: '', favicon: '', loading: false,
      pinned: pinned && !isPrivate, groupId: null, sleeping: null, inactiveSince: Date.now(),
    };
    // Pinned tabs stay together at the start of the strip; others come after them.
    const pinnedCount = this.pinnedCount();
    const place = tab.pinned ? pinnedCount : Math.max(pinnedCount, index ?? this.order.length);
    this.register(tab, place);
    this.wireCommon(tab);
    this.wireWeb(tab);
    this.emit('created', tab);

    if (url && isAllowedUrl(url)) view.webContents.loadURL(url).catch(() => {});
    else this.loadNewTabPage(view.webContents);

    if (activate || this.activeId === null) this.activate(id);
    this.emit('change');
    return tab;
  }

  newWebView(id, isPrivate) {
    const partition = this.sessions.partitionFor(id, isPrivate);
    this.sessions.ensure(partition, isPrivate ? 'private' : 'web');
    const view = new WebContentsView({ webPreferences: contentPreferences(partition) });
    view.setBackgroundColor('#ffffff');
    view.setVisible(false);
    return view;
  }

  pinnedCount() {
    return this.order.filter((id) => this.tabs.get(id)?.pinned).length;
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
    // A page can close its own tab (window.close() in a sign-in popup, say): the tab goes too,
    // or it would stay listed with no page behind it. Not while the window itself is closing.
    // (Not when the browser closed the page itself to put the tab to sleep: the tab has no view
    // then. The view is compared, as a closed page's view no longer holds it.)
    const view = tab.view;
    contents.once('destroyed', () => {
      if (!this.shuttingDown && this.tabs.get(tab.id) === tab && tab.view === view) this.close(tab.id);
    });

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
        if (tab.faviconSource !== source || !isLive(contents)) return;
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
      // The browser's own pages (History, Settings...) simply load again.
      if (tab.kind === 'internal' && details.reason !== 'clean-exit' && !this.shuttingDown && isLive(contents)) contents.reload();
    });
  }

  // A web page that crashed shows the crash page in its tab, with the page's own address kept in
  // the address bar. Reload and Close tab on it set the crash page's #hash (it has no bridge to
  // the browser); only the crash page itself can do that, so no web page can close a tab this way.
  isCrashPage(url) {
    return isAppUrl(url) && new URL(url).pathname === `/${this.crashedPage}`;
  }

  showCrash(tab, reason) {
    const contents = tab.view.webContents;
    if (this.shuttingDown || !isLive(contents)) return;
    const current = contents.getURL();
    // A crash of the crash page (or of a page not loaded yet) keeps what is known already.
    const url = this.isCrashPage(current) ? tab.crashed?.url ?? '' : current;
    tab.crashed = { url: isAllowedUrl(url) ? url : '', reason };
    tab.loading = false;
    contents.loadURL(appUrl(this.crashedPage, { query: { url: tab.crashed.url, reason } })).catch(() => {});
    this.emit('crashed', tab, tab.crashed);
    this.emit('change');
  }

  wireWeb(tab) {
    const contents = tab.view.webContents;
    const changed = () => this.emit('change');

    attachNavigationGuards(contents, {
      openInNewTab: (url) => this.create({ url, isPrivate: tab.isPrivate }),
      onBlocked: this.onBlocked,
    });
    contents.on('render-process-gone', (_event, details) => {
      if (details.reason !== 'clean-exit') this.showCrash(tab, details.reason);
    });
    contents.on('did-navigate', (_event, url) => {
      if (!this.isCrashPage(url)) tab.crashed = null;
      tab.blocked = 0; // a new page: count and list its own blocked requests
      tab.blockedLog?.clear();
      this.zoom?.apply(tab);
      this.emit('navigated', tab, url);
      changed();
    });
    contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (isMainFrame && tab.crashed && this.isCrashPage(url)) {
        const action = new URL(url).hash;
        if (action === '#close') setImmediate(() => this.close(tab.id));
        else if (action === '#reload' && tab.crashed.url) contents.loadURL(tab.crashed.url).catch(() => {});
        return;
      }
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

  // The window is closing: its pages are closed with it, and their tabs are no longer replaced.
  shutdown() {
    this.shuttingDown = true;
  }

  get active() {
    return this.tabs.get(this.activeId) ?? null;
  }

  internalContents() {
    return [...this.tabs.values()]
      .filter((tab) => tab.kind === 'internal' && isLive(tab.view?.webContents))
      .map((tab) => tab.view.webContents);
  }

  activate(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    if (tab.sleeping) this.wake(tab);
    const previous = this.tabs.get(this.activeId);
    if (previous && previous !== tab) previous.inactiveSince = Date.now();
    tab.inactiveSince = null;
    // A tab in a collapsed group opens the group.
    const group = tab.groupId ? this.groups.get(tab.groupId) : null;
    if (group?.collapsed) group.collapsed = false;
    this.activeId = id;
    for (const other of this.tabs.values()) other.view?.setVisible(other === tab);
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
    const contents = tab.view?.webContents;
    const alive = isLive(contents);
    const url = tab.sleeping ? tab.sleeping.url : alive ? contents.getURL() : '';
    if (tab.kind === 'web' && !tab.isPrivate && isAllowedUrl(url)) {
      this.closed.push({ url, index });
      if (this.closed.length > MAX_CLOSED) this.closed.shift();
    }
    this.order.splice(index, 1);
    this.tabs.delete(id);
    if (tab.view) this.host.removeContentView(tab.view);
    if (alive) contents.close();
    if (tab.groupId) this.dropEmptyGroup(tab.groupId);
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

  // Moves a tab to another place in the tab strip: pinned tabs within the pinned block, others
  // after it. Dropped between two tabs of a group, a tab joins it; dragged away from its own
  // group, it leaves it.
  move(id, index) {
    const from = this.order.indexOf(id);
    if (from === -1) return false;
    const tab = this.tabs.get(id);
    this.order.splice(from, 1);
    const pinnedCount = this.pinnedCount();
    const low = tab.pinned ? 0 : pinnedCount;
    const high = tab.pinned ? pinnedCount : this.order.length;
    this.order.splice(Math.max(low, Math.min(index, high)), 0, id);
    if (!tab.pinned) this.followNeighbours(tab);
    this.emit('change');
    return true;
  }

  followNeighbours(tab) {
    const at = this.order.indexOf(tab.id);
    const before = this.tabs.get(this.order[at - 1])?.groupId ?? null;
    const after = this.tabs.get(this.order[at + 1])?.groupId ?? null;
    if (before && before === after) {
      const old = tab.groupId;
      tab.groupId = before;
      if (old && old !== before) this.dropEmptyGroup(old);
    } else if (tab.groupId && before !== tab.groupId && after !== tab.groupId) {
      const old = tab.groupId;
      tab.groupId = null;
      this.dropEmptyGroup(old);
    }
  }

  // ---------- Pinned tabs ----------
  // Small, at the start of the strip, kept for the next start; only regular web tabs.
  pin(id, pinned) {
    const tab = this.tabs.get(id);
    if (!tab || tab.kind !== 'web' || tab.isPrivate || tab.pinned === pinned) return false;
    const from = this.order.indexOf(id);
    this.order.splice(from, 1);
    if (pinned && tab.groupId) {
      const old = tab.groupId;
      tab.groupId = null;
      this.dropEmptyGroup(old);
    }
    tab.pinned = pinned;
    // Pinned: last of the pinned block. Unpinned: first after it.
    this.order.splice(this.pinnedCount(), 0, id);
    this.emit('pinned', tab);
    this.emit('change');
    return true;
  }

  // The pinned tabs' addresses, in order, for the next start.
  pinnedUrls() {
    return this.order.map((id) => this.tabs.get(id))
      .filter((tab) => tab.pinned)
      .map((tab) => (tab.sleeping ? tab.sleeping.url : tab.view.webContents.getURL()))
      .filter((url) => isAllowedUrl(url));
  }

  // ---------- Tab groups ----------
  // A group's tabs always sit next to each other. A group with no tabs left goes away.
  groupMembers(groupId) {
    return this.order.filter((id) => this.tabs.get(id)?.groupId === groupId);
  }

  newGroup(tabId, { name = '', color } = {}) {
    const tab = this.tabs.get(tabId);
    if (!tab || tab.kind !== 'web' || tab.pinned) return null;
    const used = new Set([...this.groups.values()].map((group) => group.color));
    const id = `g${this.nextGroupId++}`;
    const group = {
      id,
      name: String(name).slice(0, MAX_GROUP_NAME),
      color: GROUP_COLORS.includes(color) ? color : GROUP_COLORS.find((choice) => !used.has(choice)) ?? GROUP_COLORS[0],
      collapsed: false,
    };
    this.groups.set(id, group);
    const old = tab.groupId;
    tab.groupId = id;
    if (old) this.dropEmptyGroup(old);
    this.emit('change');
    return id;
  }

  // Puts the tab at the end of the group.
  addToGroup(tabId, groupId) {
    const tab = this.tabs.get(tabId);
    if (!tab || tab.kind !== 'web' || tab.pinned || !this.groups.has(groupId) || tab.groupId === groupId) return false;
    const old = tab.groupId;
    this.order.splice(this.order.indexOf(tabId), 1);
    const members = this.groupMembers(groupId);
    this.order.splice(this.order.indexOf(members.at(-1)) + 1, 0, tabId);
    tab.groupId = groupId;
    if (old) this.dropEmptyGroup(old);
    this.emit('change');
    return true;
  }

  // Takes the tab out, just after the group.
  removeFromGroup(tabId) {
    const tab = this.tabs.get(tabId);
    const groupId = tab?.groupId;
    if (!groupId) return false;
    this.order.splice(this.order.indexOf(tabId), 1);
    const members = this.groupMembers(groupId);
    const at = members.length ? this.order.indexOf(members.at(-1)) + 1 : this.order.length;
    this.order.splice(at, 0, tabId);
    tab.groupId = null;
    this.dropEmptyGroup(groupId);
    this.emit('change');
    return true;
  }

  updateGroup(groupId, { name, color, collapsed } = {}) {
    const group = this.groups.get(groupId);
    if (!group) return false;
    if (typeof name === 'string') group.name = name.trim().slice(0, MAX_GROUP_NAME);
    if (GROUP_COLORS.includes(color)) group.color = color;
    if (typeof collapsed === 'boolean') {
      group.collapsed = collapsed;
      // The page shown can't be hidden: another tab outside the group takes over.
      if (collapsed && this.tabs.get(this.activeId)?.groupId === groupId) {
        const outside = this.order.find((id) => this.tabs.get(id).groupId !== groupId);
        if (outside) this.activate(outside);
        else group.collapsed = false;
      }
    }
    this.emit('change');
    return true;
  }

  ungroup(groupId) {
    if (!this.groups.has(groupId)) return false;
    for (const tab of this.tabs.values()) if (tab.groupId === groupId) tab.groupId = null;
    this.groups.delete(groupId);
    this.emit('change');
    return true;
  }

  closeGroup(groupId) {
    const members = this.groupMembers(groupId);
    for (const id of members) this.close(id);
    return members.length;
  }

  dropEmptyGroup(groupId) {
    if (this.groupMembers(groupId).length === 0) this.groups.delete(groupId);
  }

  groupsSnapshot() {
    return [...this.groups.values()].map((group) => ({ ...group, count: this.groupMembers(group.id).length }));
  }

  // Groups from a saved session: { name, color, collapsed, tabs: [tab ids] }.
  restoreGroups(saved) {
    for (const entry of saved) {
      const ids = entry.tabs.filter((id) => this.tabs.get(id)?.kind === 'web' && !this.tabs.get(id).pinned);
      if (ids.length === 0) continue;
      const groupId = this.newGroup(ids[0], entry);
      for (const id of ids.slice(1)) this.addToGroup(id, groupId);
      if (entry.collapsed) this.updateGroup(groupId, { collapsed: true });
    }
  }

  // ---------- Sleeping tabs ----------
  // A sleeping tab has no page: its process is closed, which frees its memory. Its history
  // (with each page's scroll position and form values), title, icon, zoom and muting are kept,
  // and it wakes where it was when it is shown again.
  async canSleep(id, { isBusy = () => false } = {}) {
    const tab = this.tabs.get(id);
    if (!tab || tab.kind !== 'web' || tab.sleeping || tab.pinned || tab.crashed || id === this.activeId) return false;
    const contents = tab.view?.webContents;
    if (!isLive(contents) || contents.isLoading() || contents.isCurrentlyAudible() || isBusy(tab)) return false;
    if (!/^https?:/i.test(contents.getURL())) return false;
    try {
      // Something typed into the page and not sent is never risked.
      const page = await contents.executeJavaScriptInIsolatedWorld(SLEEP_CHECK_WORLD, [{ code: TYPED_CHECK }]);
      if (page?.typed !== false) return false;
      tab.scrolledTo = { x: Number(page.x) || 0, y: Number(page.y) || 0 };
      return true;
    } catch {
      return false;
    }
  }

  sleep(id) {
    const tab = this.tabs.get(id);
    const contents = tab?.view?.webContents;
    if (!tab || tab.sleeping || id === this.activeId || !isLive(contents)) return false;
    const history = contents.navigationHistory;
    tab.sleeping = {
      entries: history.getAllEntries(),
      index: history.getActiveIndex(),
      url: contents.getURL(),
      zoom: contents.getZoomFactor(),
      muted: contents.isAudioMuted(),
      scroll: tab.scrolledTo ?? null,
      since: Date.now(),
    };
    const { view } = tab;
    tab.view = null; // before the page goes, so its closing doesn't close the tab
    this.host.removeContentView(view);
    contents.close();
    this.emit('slept', tab);
    this.emit('change');
    return true;
  }

  wake(tab) {
    const { entries, index, url, zoom, muted, scroll } = tab.sleeping;
    const view = this.newWebView(tab.id, tab.isPrivate);
    tab.view = view;
    tab.sleeping = null;
    tab.loading = true;
    this.host.addContentView(view);
    this.wireCommon(tab);
    this.wireWeb(tab);
    this.emit('created', tab);
    const contents = view.webContents;
    contents.setAudioMuted(muted);
    contents.setZoomFactor(zoom);
    contents.navigationHistory.restore({ entries, index }).catch(() => contents.loadURL(url).catch(() => {}));
    // Chromium puts the page back where it was when it can; when it comes back at the top, the
    // place noted before it slept is used.
    if (scroll && (scroll.x || scroll.y)) {
      contents.once('did-finish-load', () => {
        if (!isLive(contents)) return;
        contents.executeJavaScriptInIsolatedWorld(SLEEP_CHECK_WORLD, [{
          code: `if (window.scrollX === 0 && window.scrollY === 0) window.scrollTo(${scroll.x}, ${scroll.y})`,
        }]).catch(() => {});
      });
    }
    this.emit('woke', tab);
  }

  // One more ad or tracker request blocked in the tab showing `contentsId`; `request` (url,
  // resourceType, kind) goes into the tab's list for the shield's panel.
  countBlocked(contentsId, request) {
    for (const tab of this.tabs.values()) {
      const contents = tab.view?.webContents;
      if (!contents || contents.isDestroyed() || contents.id !== contentsId) continue;
      tab.blocked = (tab.blocked ?? 0) + 1;
      if (request) (tab.blockedLog ??= new BlockedLog()).add(request);
      this.emit('change');
      return;
    }
  }

  toggleMute(id) {
    const tab = this.tabs.get(id);
    if (tab?.sleeping) {
      tab.sleeping.muted = !tab.sleeping.muted;
      this.emit('change');
      return tab.sleeping.muted;
    }
    const contents = tab?.view?.webContents;
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
      if (tab.sleeping) return this.sleepingSnapshot(tab);
      const contents = tab.view.webContents;
      const url = contents.getURL();
      const internal = tab.kind === 'internal';
      // A crashed page's tab shows the page's address, not the crash page's.
      const crashed = Boolean(tab.crashed) && this.isCrashPage(url);
      return {
        id,
        kind: tab.kind,
        title: tab.title || (internal ? 'Simple Browser' : isAppUrl(url) ? 'New tab' : url),
        url: internal ? internalUrl(tab.page) : crashed ? tab.crashed.url : isAppUrl(url) ? '' : url,
        crashed,
        favicon: tab.favicon,
        loading: tab.loading,
        isPrivate: tab.isPrivate,
        zoom: Math.round(contents.getZoomFactor() * 100) / 100,
        blocked: tab.blocked ?? 0,
        audible: contents.isCurrentlyAudible(),
        muted: contents.isAudioMuted(),
        canGoBack: contents.navigationHistory.canGoBack(),
        canGoForward: contents.navigationHistory.canGoForward(),
        pinned: Boolean(tab.pinned),
        groupId: tab.groupId ?? null,
        sleeping: false,
        readerable: Boolean(tab.readerable) && !crashed,
      };
    });
  }

  sleepingSnapshot(tab) {
    const { url, zoom, muted, index, entries } = tab.sleeping;
    return {
      id: tab.id,
      kind: tab.kind,
      title: tab.title || url,
      url,
      crashed: false,
      favicon: tab.favicon,
      loading: false,
      isPrivate: tab.isPrivate,
      zoom: Math.round(zoom * 100) / 100,
      blocked: tab.blocked ?? 0,
      audible: false,
      muted,
      canGoBack: index > 0,
      canGoForward: index < entries.length - 1,
      pinned: Boolean(tab.pinned),
      groupId: tab.groupId ?? null,
      sleeping: true,
      readerable: false,
    };
  }

  // Open regular web pages, for restoring the session on the next start.
  sessionSnapshot() {
    const urls = [];
    let active = 0;
    const grouped = new Map(); // group id -> indexes into urls
    for (const id of this.order) {
      const tab = this.tabs.get(id);
      if (tab.kind !== 'web' || tab.isPrivate || tab.pinned) continue;
      const url = tab.sleeping ? tab.sleeping.url : tab.view.webContents.getURL();
      if (!isAllowedUrl(url)) continue;
      if (id === this.activeId) active = urls.length;
      if (tab.groupId) {
        if (!grouped.has(tab.groupId)) grouped.set(tab.groupId, []);
        grouped.get(tab.groupId).push(urls.length);
      }
      urls.push(url);
    }
    const groups = [...grouped].map(([groupId, tabs]) => {
      const { name, color, collapsed } = this.groups.get(groupId);
      return { name, color, collapsed, tabs };
    });
    return { urls, active, groups };
  }
}

module.exports = { TabManager, GROUP_COLORS };
