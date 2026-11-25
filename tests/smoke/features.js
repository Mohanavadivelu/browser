'use strict';

// Smoke test for find, zoom, history, the library pages, screenshots, downloads policy,
// recording pause, recording quality and recording that follows the active tab.
// Run with: npm run smoke
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { app } = require('electron');
const { start } = require('../../src/main/app');
const { keyframeTimes } = require('../../src/main/recording/webm-edit');
const bookmarkTree = require('../../src/main/bookmarks');
// An independent WebM reader, to check what the app writes into files.
const { inspect: inspectWebm } = require('../unit/webm-fixtures');
const {
  sleep, waitFor, createChecker, makeTempDir, trackBytes, ensureWindowReady, inspectRecording, stubDialog,
} = require('./helpers');

const { check, finish } = createChecker();

const PAGES = {
  '/': '<!doctype html><title>Home Page</title><body style="margin:0"><h1 style="margin:0;height:240px;background:#e00;color:#fff">HOME</h1></body>',
  '/other': '<!doctype html><title>Other Page</title><body>other</body>',
  '/text': '<!doctype html><title>Text Page</title><body><p>banana apple banana</p><p>banana cherry</p><p>Banana split and banana bread</p></body>',
};
// A 1x1 red PNG for the tab icon test.
const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');
const ANIMATED = '<!doctype html><title>Animated</title><style>@keyframes m{from{left:0}to{left:70vw}}' +
  'body{margin:0}h1{margin:0;height:200px;background:#e00}#b{position:absolute;top:240px;width:120px;height:120px;background:#06c;animation:m 2s linear infinite alternate}</style><h1></h1><div id=b></div>';

async function main() {
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  // Chromium's fake microphone (a test tone) stands in for a real one in the narration check.
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  const work = makeTempDir();
  const iconRequests = []; // the Cookie header of each request for /icon.png
  const dialogTargets = { save: '', open: '' }; // what the stubbed Save and Open dialogs answer
  const adRequests = []; // requests that reached the server for blocked paths
  const server = http.createServer((req, res) => {
    if (req.url === '/setup.exe') {
      res.setHeader('content-type', 'application/octet-stream');
      res.setHeader('content-disposition', 'attachment; filename="setup.exe"');
      res.end('MZ-not-a-real-program');
      return;
    }
    if (req.url === '/ad-page') {
      res.setHeader('content-type', 'text/html');
      res.end('<!doctype html><title>Ad Page</title><script src="/adserver/ad.js"></script><img src="/tracker/pixel.gif"><script src="/app.js"></script><p>article</p>');
      return;
    }
    if (req.url.startsWith('/adserver/') || req.url.startsWith('/tracker/')) {
      adRequests.push(req.url);
      res.setHeader('content-type', req.url.endsWith('.js') ? 'text/javascript' : 'image/png');
      res.end(req.url.endsWith('.js') ? 'window.adLoaded = true;' : TINY_PNG);
      return;
    }
    if (req.url === '/app.js') {
      res.setHeader('content-type', 'text/javascript');
      res.end('window.appLoaded = true;');
      return;
    }
    if (req.url === '/icon-page') {
      res.setHeader('set-cookie', 'icon-probe=private; Path=/');
      res.setHeader('content-type', 'text/html');
      res.end('<!doctype html><title>Icon Page</title><link rel="icon" href="/icon.png"><p>icon</p>');
      return;
    }
    if (req.url === '/icon.png') {
      iconRequests.push(req.headers.cookie ?? '');
      res.setHeader('content-type', 'image/png');
      res.end(TINY_PNG);
      return;
    }
    if (req.url === '/disk.iso' || req.url === '/renamed.txt') {
      res.setHeader('content-type', 'application/octet-stream');
      res.setHeader('content-disposition', `attachment; filename="${req.url.slice(1)}"`);
      res.end('not a real file\n'.repeat(500));
      return;
    }
    if (req.url === '/report.txt') {
      res.setHeader('content-type', 'application/octet-stream');
      res.setHeader('content-disposition', 'attachment; filename="report.txt"');
      res.end('quarterly numbers\n'.repeat(1000));
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.end(req.url.startsWith('/anim') ? ANIMATED : PAGES[req.url] ?? PAGES['/other']);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const ctx = await start({
    userDataDir: path.join(work, 'profile'),
    skipSingleInstanceLock: true,
    // Test filters instead of downloading the real ad and tracker lists.
    blockerFilters: ['/adserver/*', '/tracker/*'].join('\n'),
    autoConsent: true,
    idleMs: 60_000,
    downloadDir: path.join(work, 'downloads'),
    // Stands in for the user typing a new name in the Save dialog.
    downloadSaveName: (name) => (name === 'renamed.txt' ? 'renamed.exe' : path.basename(name)),
    // The last check closes the window; keep the app running to report the results.
    quitOnClose: false,
    dialog: stubDialog(dialogTargets),
    minuteMs: 600, // a "minute" of 0.6 s for the stop-after check
  });
  const { host, tabs, recorder, settings, history, ui, find, actions, recordingsIndex } = ctx;
  const bytes = trackBytes(recorder);
  const startRecording = async () => {
    await ensureWindowReady(ctx);
    ui.webContents.send('recording:command', 'start');
  };
  const recordingsFolder = path.join(work, 'recordings');
  settings.update({ recordingFolder: recordingsFolder });
  await waitFor(() => !ui.webContents.isLoading() && !find.webContents.isLoading() && ctx.win.isVisible(), 'window ready');
  ui.webContents.on('console-message', (event) => { if (event.level === 'error') console.log(`[chrome error] ${event.message}`); });

  const notices = [];
  const originalSend = ui.webContents.send.bind(ui.webContents);
  ui.webContents.send = (channel, ...args) => {
    if (channel === 'ui:notice') notices.push(args[0].text);
    return originalSend(channel, ...args);
  };
  const noticeLike = (pattern) => notices.some((text) => pattern.test(text));
  const load = async (url, tab = tabs.active) => {
    tab.view.webContents.loadURL(url).catch(() => {});
    await waitFor(() => tab.view.webContents.getURL() === url && !tab.view.webContents.isLoading(), `load ${url}`);
  };
  const evalIn = (view, code) => view.webContents.executeJavaScript(code);

  // ---------- Defaults ----------
  check('search engine defaults to Google', settings.data.searchEngine === 'google');
  check('history is off by default', settings.data.historyEnabled === false);
  check('restoring tabs is off by default', settings.data.restoreTabs === false);

  // ---------- Find in page ----------
  await load(`${base}/text`);
  actions.find();
  await waitFor(() => host.mode.findOpen, 'find bar opens');
  const findBounds = find.getBounds();
  check('find bar opens below the toolbar', find.getVisible() && findBounds.y >= 116, `y=${findBounds.y}`);
  await sleep(300);
  await evalIn(find, "(() => { const i = document.getElementById('query'); i.value = 'banana'; i.dispatchEvent(new Event('input')); })()");
  await waitFor(async () => (await evalIn(find, "document.getElementById('count').textContent")) !== '', 'find result');
  const count = await evalIn(find, "document.getElementById('count').textContent");
  check('find counts every match (case-insensitive)', count === '1/5', count);
  await evalIn(find, "window.browserApi.find.query('banana', { next: true, forward: true })");
  await waitFor(async () => (await evalIn(find, "document.getElementById('count').textContent")) === '2/5', 'next match');
  check('find moves to the next match', true);
  await evalIn(find, "(() => { const i = document.getElementById('query'); i.value = 'zzzz'; i.dispatchEvent(new Event('input')); })()");
  await waitFor(async () => (await evalIn(find, "document.getElementById('count').textContent")) === 'No results', 'no results');
  check('find reports when there is no match', true);
  await evalIn(find, "window.browserApi.find.close()");
  await waitFor(() => !host.mode.findOpen, 'find bar closes');
  check('closing find hides the bar', !find.getVisible());

  // ---------- Keyboard shortcuts ----------
  const tabContents = tabs.active.view.webContents;
  tabContents.focus();
  tabContents.sendInputEvent({ type: 'keyDown', keyCode: 'F', modifiers: ['control'] });
  await sleep(400);
  const shortcutWorks = host.mode.findOpen;
  check('Ctrl+F opens find from the page', shortcutWorks);
  if (shortcutWorks) {
    find.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    await sleep(300);
    check('Esc closes find', !host.mode.findOpen);
  }
  host.closeFind();

  // ---------- Zoom ----------
  await load(`${base}/`);
  actions.zoom(1);
  check('zoom in goes to 110%', Math.abs(tabs.active.view.webContents.getZoomFactor() - 1.1) < 0.001);
  check('zoom is saved per site', settings.data.zoom['127.0.0.1'] === 1.1, JSON.stringify(settings.data.zoom));
  await load(`${base}/other`);
  check('zoom is remembered after navigating within the site', Math.abs(tabs.active.view.webContents.getZoomFactor() - 1.1) < 0.001);
  await sleep(400);
  const chip = await evalIn(ui, "(() => { const c = document.getElementById('zoom'); return c.classList.contains('show') ? c.textContent : ''; })()");
  check('the address bar shows the zoom level', chip === '110%', chip);
  await evalIn(ui, "document.getElementById('zoom').click()");
  await waitFor(() => Math.abs(tabs.active.view.webContents.getZoomFactor() - 1) < 0.001, 'zoom reset');
  check('clicking the zoom chip resets zoom', !('127.0.0.1' in settings.data.zoom));
  const privateTab = tabs.create({ url: `${base}/`, isPrivate: true });
  await waitFor(() => privateTab.view.webContents.getURL() === `${base}/`, 'private tab loaded');
  actions.zoom(1);
  check('private tabs do not save zoom', Object.keys(settings.data.zoom).length === 0);
  tabs.close(privateTab.id);

  // ---------- History ----------
  await load(`${base}/`);
  check('nothing is recorded while history is off', history.entries.length === 0);
  settings.update({ historyEnabled: true });
  await load(`${base}/text`);
  await load(`${base}/other`);
  check('history records pages once it is on', history.list().some((e) => e.url === `${base}/text`) && history.list().length >= 2);
  check('history stores page titles', history.list().find((e) => e.url === `${base}/text`)?.title === 'Text Page');

  // ---------- Address-bar suggestions ----------
  ui.webContents.focus(); // as Ctrl+L does: the address bar only takes focus inside a focused view
  await evalIn(ui, `(() => { const a = document.getElementById('address'); a.focus(); a.value = 'text p';
    a.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await waitFor(async () => /Text Page/.test(await evalIn(ui, "document.getElementById('suggestions').textContent")), 'suggestion list', 5000).catch(() => {});
  const suggested = await evalIn(ui, "[...document.querySelectorAll('#suggestions .suggestion')].map((row) => row.textContent)");
  check('typing in the address bar suggests a visited page', suggested.length >= 2 && /Search Google/.test(suggested[0]) && suggested.some((row) => /Text Page/.test(row)), suggested.join(' | '));
  check('the suggestion list gets room below the bars', ui.getBounds().height > 116, `toolbar view ${ui.getBounds().height}px`);
  await load(`${base}/other`);
  ui.webContents.focus(); // as Ctrl+L does: the address bar only takes focus inside a focused view
  await evalIn(ui, `(() => { const a = document.getElementById('address'); a.focus(); a.value = 'text p';
    a.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await waitFor(async () => /Text Page/.test(await evalIn(ui, "document.getElementById('suggestions').textContent")), 'suggestion list again', 5000);
  await evalIn(ui, "[...document.querySelectorAll('#suggestions .suggestion')].find((row) => /Text Page/.test(row.textContent)).click()");
  await waitFor(() => tabs.snapshot().find((tab) => tab.id === tabs.activeId).url === `${base}/text`, 'suggestion opened', 5000).catch(() => {});
  check('choosing a suggestion opens it', tabs.snapshot().find((tab) => tab.id === tabs.activeId).url === `${base}/text`);
  await waitFor(() => ui.getBounds().height === 116, 'suggestion list closed', 3000).catch(() => {});
  check('the toolbar view shrinks back when the list closes', ui.getBounds().height === 116, `${ui.getBounds().height}px`);
  const before = history.entries.length;
  const privateTab2 = tabs.create({ url: `${base}/anim-private`, isPrivate: true });
  await waitFor(() => privateTab2.view.webContents.getURL().endsWith('/anim-private'), 'private page loaded');
  check('private tabs are never added to history', history.entries.length === before);
  tabs.close(privateTab2.id);

  // ---------- Tab icons ----------
  // The page sets a cookie in the private tab's session; only that session sends it back with
  // the icon request, so the cookie shows which session fetched the icon.
  const iconTab = tabs.create({ url: `${base}/icon-page`, isPrivate: true });
  await waitFor(() => iconTab.favicon.startsWith('data:'), 'private tab icon', 10000);
  check('tab icons reach the toolbar as data: URLs', iconTab.favicon.startsWith('data:image/png;base64,'), iconTab.favicon.slice(0, 30));
  check("a private tab's icon is fetched through its own session", iconRequests.length > 0 && iconRequests.every((cookie) => /icon-probe=private/.test(cookie)),
    JSON.stringify(iconRequests));
  const stripIcon = () => evalIn(ui, "document.querySelector('.tab.active img.fav')?.src ?? ''");
  await waitFor(async () => (await stripIcon()) !== '', 'icon shown in the tab strip').catch(() => {});
  const shownIcon = await stripIcon();
  check('the toolbar shows the icon without loading it itself', shownIcon.startsWith('data:image/png'), shownIcon.slice(0, 30));
  tabs.close(iconTab.id);

  // ---------- Tab basics: reopen, drag, mute ----------
  const tabOne = tabs.create({ url: `${base}/tab-one` });
  const tabTwo = tabs.create({ url: `${base}/tab-two` });
  await waitFor(() => tabOne.view.webContents.getURL().endsWith('/tab-one') && tabTwo.view.webContents.getURL().endsWith('/tab-two'), 'tabs for the tab tests');
  const placeOne = tabs.order.indexOf(tabOne.id);
  tabs.close(tabOne.id);
  const reopened = tabs.reopenClosed();
  await waitFor(() => reopened?.view.webContents.getURL().endsWith('/tab-one'), 'closed tab reopened');
  check('a closed tab reopens with its page, where it was', tabs.order.indexOf(reopened.id) === placeOne, `at ${tabs.order.indexOf(reopened.id)}, was ${placeOne}`);
  const secretTab = tabs.create({ url: `${base}/secret`, isPrivate: true });
  await waitFor(() => secretTab.view.webContents.getURL().endsWith('/secret'), 'private page for the reopen test');
  tabs.close(secretTab.id);
  check('closed private tabs are not kept for reopening', !tabs.closed.some((entry) => entry.url.endsWith('/secret')));

  // Drag the last tab to the front of the strip, with real drag events in the toolbar.
  const lastId = tabs.order.at(-1);
  await evalIn(ui, `(() => {
    const strip = document.getElementById('tabs');
    const dragged = strip.querySelector('.tab[data-id="${lastId}"]');
    const first = strip.children[0].getBoundingClientRect();
    const data = new DataTransfer();
    dragged.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: data }));
    const at = { bubbles: true, cancelable: true, dataTransfer: data, clientX: first.left + 3, clientY: first.top + 5 };
    strip.dispatchEvent(new DragEvent('dragover', at));
    strip.dispatchEvent(new DragEvent('drop', at));
    dragged.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: data }));
  })()`);
  await waitFor(() => tabs.order[0] === lastId, 'tab dragged to the front', 3000).catch(() => {});
  check('dragging a tab moves it in the strip', tabs.order[0] === lastId, tabs.order.join(','));

  tabs.activate(reopened.id);
  await reopened.view.webContents.executeJavaScript(`(() => { const c = new AudioContext(); const o = c.createOscillator();
    const g = c.createGain(); g.gain.value = 0.2; o.connect(g).connect(c.destination); o.start(); return c.resume(); })()`, true);
  const soundIcon = () => evalIn(ui, `document.querySelector('.tab[data-id="${reopened.id}"] .sound')?.textContent ?? ''`);
  await waitFor(async () => (await soundIcon()) === '🔊', 'sound icon on the playing tab', 8000).catch(() => {});
  check('a tab playing sound shows a sound icon', (await soundIcon()) === '🔊', await soundIcon());
  await evalIn(ui, `document.querySelector('.tab[data-id="${reopened.id}"] .sound').click()`);
  await waitFor(async () => reopened.view.webContents.isAudioMuted() && (await soundIcon()) === '🔇', 'tab muted', 3000).catch(() => {});
  check('clicking the sound icon mutes the tab', reopened.view.webContents.isAudioMuted() && (await soundIcon()) === '🔇', await soundIcon());
  tabs.close(reopened.id);
  tabs.close(tabTwo.id);

  // ---------- Library pages ----------
  const webTabCount = tabs.order.length;
  tabs.navigate('simple-browser://settings');
  const internal = tabs.active;
  await waitFor(() => internal.kind === 'internal' && !internal.view.webContents.isLoading() && internal.title === 'Settings', 'settings page loaded');
  check('settings opens in its own tab', internal.kind === 'internal' && tabs.order.length === webTabCount + 1);
  check('settings page shows the saved search engine',
    (await evalIn(internal.view, "document.getElementById('searchEngine').value")) === 'google');
  await evalIn(internal.view, "(() => { const s = document.getElementById('searchEngine'); s.value = 'bing'; s.dispatchEvent(new Event('change')); })()");
  await waitFor(() => settings.data.searchEngine === 'bing', 'search engine saved');
  check('changing a setting saves it', settings.data.searchEngine === 'bing');
  await evalIn(internal.view, "(() => { const s = document.getElementById('searchEngine'); s.value = 'google'; s.dispatchEvent(new Event('change')); })()");
  await waitFor(() => settings.data.searchEngine === 'google', 'search engine restored');
  const patchResult = await evalIn(internal.view, "window.browserApi.settings.update({ bookmarks: [{ url: 'https://evil.example' }], zoom: { a: 3 } }).then((s) => Object.keys(s).includes('bookmarks'))");
  check('settings page cannot change protected data', patchResult === false && bookmarkTree.links(settings.data.bookmarks).length === 0 && !settings.data.zoom.a);
  tabs.navigate(`${base}/`);
  await waitFor(() => tabs.active !== internal && tabs.active.kind === 'web', 'web address opens a new tab');
  check('web addresses never load inside an internal tab', internal.view.webContents.getURL().includes('library.html'));
  tabs.openInternal('history');
  await waitFor(() => internal.title === 'History', 'history page');
  await waitFor(async () => (await evalIn(internal.view, "document.querySelectorAll('#historyList .row').length")) >= 2, 'history rows');
  check('history page lists visited pages', true);
  await evalIn(internal.view, "document.getElementById('historyClear').click()");
  await waitFor(() => history.entries.length === 0, 'history cleared');
  check('history can be cleared', history.entries.length === 0);

  // ---------- Screenshot ----------
  const web = tabs.order.map((id) => tabs.tabs.get(id)).find((tab) => tab.kind === 'web');
  tabs.activate(web.id);
  await load(`${base}/`, web);
  await sleep(500);
  const shot = await actions.screenshot();
  const png = shot ? fs.readFileSync(shot) : Buffer.alloc(0);
  check('screenshot saves a PNG file', shot && png.subarray(1, 4).toString() === 'PNG' && png.length > 2000, shot ? `${png.length} bytes` : notices.at(-1));

  // ---------- Bookmarks: folders and the bookmarks page ----------
  // The flat list of earlier versions becomes the Bookmarks bar.
  settings.update({ bookmarks: ['a', 'b', 'c'].map((key) => ({ url: `${base}/bm-${key}`, title: `Bm ${key.toUpperCase()}` })) });
  const titlesOf = (nodes) => nodes.map((node) => node.title).join(',');
  check('bookmarks from earlier versions move into the Bookmarks bar', titlesOf(settings.data.bookmarks.bar.children) === 'Bm A,Bm B,Bm C');
  const linkId = (title) => bookmarkTree.links(settings.data.bookmarks).find((link) => link.title === title)?.id;
  const workFolder = () => settings.data.bookmarks.bar.children.find((node) => node.type === 'folder' && node.title === 'Work');

  tabs.openInternal('bookmarks');
  const bookmarksPage = tabs.active;
  await waitFor(() => bookmarksPage.title === 'Bookmarks', 'bookmarks page');
  const inBookmarks = (code) => evalIn(bookmarksPage.view, code);
  const rowTitles = () => inBookmarks("[...document.querySelectorAll('#bookmarkList .bm-row .title')].map((b) => b.textContent).join(',')");
  const rowSelector = (id) => `#bookmarkList .bm-row[data-id="${id}"]`;
  const clickInBookmarkRow = (id, label) => inBookmarks(`[...document.querySelector(${JSON.stringify(rowSelector(id))}).querySelectorAll('button')].find((b) => b.textContent === ${JSON.stringify(label)}).click()`);
  const dragBookmark = (fromSelector, toSelector, fraction) => inBookmarks(`(() => {
    const from = document.querySelector(${JSON.stringify(fromSelector)});
    const to = document.querySelector(${JSON.stringify(toSelector)});
    const data = new DataTransfer();
    from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: data }));
    const box = to.getBoundingClientRect();
    const at = { bubbles: true, cancelable: true, dataTransfer: data, clientX: box.left + 20, clientY: box.top + box.height * ${fraction} };
    to.dispatchEvent(new DragEvent('dragover', at));
    to.dispatchEvent(new DragEvent('drop', at));
    from.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: data }));
  })()`);
  await waitFor(async () => (await rowTitles()) === 'Bm A,Bm B,Bm C', 'bookmark rows');

  // A new folder, named in place.
  await inBookmarks("document.getElementById('bookmarksNewFolder').click()");
  await waitFor(() => inBookmarks("Boolean(document.querySelector('#bookmarkList .bm-row input[type=text]'))"), 'new folder name field', 3000);
  await inBookmarks(`(() => { const input = document.querySelector('#bookmarkList .bm-row input[type=text]');
    input.value = 'Work'; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); })()`);
  await waitFor(() => Boolean(workFolder()), 'folder named', 3000).catch(() => {});
  check('a folder can be made and named on the bookmarks page', Boolean(workFolder()));

  // Tick two bookmarks and move them into the folder together.
  for (const title of ['Bm B', 'Bm C']) await inBookmarks(`document.querySelector(${JSON.stringify(`${rowSelector(linkId(title))} input[type=checkbox]`)}).click()`);
  await inBookmarks(`(() => { document.getElementById('bookmarksMoveTo').value = ${JSON.stringify(workFolder().id)}; document.getElementById('bookmarksMove').click(); })()`);
  await waitFor(() => titlesOf(workFolder()?.children ?? []) === 'Bm B,Bm C', 'moved into Work', 3000).catch(() => {});
  check('several bookmarks move into a folder together', titlesOf(workFolder().children) === 'Bm B,Bm C' && titlesOf(settings.data.bookmarks.bar.children) === 'Bm A,Work');

  // Open the folder from the tree, then reorder with ↓ and by dragging.
  await inBookmarks(`document.querySelector('#bookmarkFolders [data-id="${workFolder().id}"]').click()`);
  await waitFor(async () => (await rowTitles()) === 'Bm B,Bm C', 'Work opened', 3000).catch(() => {});
  await clickInBookmarkRow(linkId('Bm B'), '↓');
  await waitFor(() => titlesOf(workFolder().children) === 'Bm C,Bm B', 'moved down', 3000).catch(() => {});
  check('a bookmark moves down inside its folder', titlesOf(workFolder().children) === 'Bm C,Bm B');
  await dragBookmark(rowSelector(linkId('Bm C')), rowSelector(linkId('Bm B')), 0.9);
  await waitFor(() => titlesOf(workFolder().children) === 'Bm B,Bm C', 'dragged below', 3000).catch(() => {});
  check('dragging a bookmark reorders it', titlesOf(workFolder().children) === 'Bm B,Bm C', titlesOf(workFolder().children));

  // Drop a bookmark from the bar onto the folder in the tree.
  await inBookmarks("document.querySelector('#bookmarkFolders [data-id=\"bar\"]').click()");
  await waitFor(async () => (await rowTitles()) === 'Bm A,Work', 'bar opened', 3000).catch(() => {});
  await dragBookmark(rowSelector(linkId('Bm A')), `#bookmarkFolders [data-id="${workFolder().id}"]`, 0.5);
  await waitFor(() => titlesOf(workFolder().children) === 'Bm B,Bm C,Bm A', 'dropped on the folder', 3000).catch(() => {});
  check('dropping a bookmark on a folder in the tree moves it there', titlesOf(workFolder().children) === 'Bm B,Bm C,Bm A' &&
    titlesOf(settings.data.bookmarks.bar.children) === 'Work', titlesOf(workFolder().children));

  // Edit a bookmark's name and address.
  await inBookmarks(`document.querySelector('#bookmarkFolders [data-id="${workFolder().id}"]').click()`);
  await clickInBookmarkRow(linkId('Bm B'), 'Edit');
  await inBookmarks(`(() => { const [name, address] = document.querySelectorAll(${JSON.stringify(`${rowSelector(linkId('Bm B'))} input[type=text]`)});
    name.value = 'Renamed B'; address.value = ${JSON.stringify(`${base}/bm-b2`)}; name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); })()`);
  await waitFor(() => Boolean(linkId('Renamed B')), 'bookmark edited', 3000).catch(() => {});
  check('a bookmark can be renamed and given a new address', bookmarkTree.links(settings.data.bookmarks).some((link) => link.title === 'Renamed B' && link.url === `${base}/bm-b2`));

  // Search looks in every folder.
  await inBookmarks("(() => { const box = document.getElementById('bookmarksSearch'); box.value = 'renamed'; box.dispatchEvent(new Event('input')); })()");
  const searchMeta = await inBookmarks("[...document.querySelectorAll('#bookmarkList .bm-row .meta')].map((m) => m.textContent).join('|')");
  check('search finds bookmarks in every folder', (await rowTitles()) === 'Renamed B' && searchMeta.includes('Bookmarks bar › Work'), searchMeta);
  await inBookmarks("(() => { const box = document.getElementById('bookmarksSearch'); box.value = ''; box.dispatchEvent(new Event('input')); })()");

  // The bar shows the folder; the star files new bookmarks where they were last put.
  await waitFor(async () => /Work/.test(await evalIn(ui, "document.querySelector('#bookmarks .chip.folder')?.textContent ?? ''")), 'folder on the bar', 3000).catch(() => {});
  check('the bookmarks bar shows folders', /Work/.test(await evalIn(ui, "document.querySelector('#bookmarks .chip.folder')?.textContent ?? ''")));
  const starTab = tabs.order.map((id) => tabs.tabs.get(id)).find((tab) => tab.kind === 'web' && !tab.isPrivate);
  tabs.activate(starTab.id);
  await load(`${base}/starred`, starTab);
  actions.toggleBookmark();
  check('the star files a new bookmark in the folder used last', workFolder().children.some((node) => node.url === `${base}/starred`));
  await waitFor(async () => (await evalIn(ui, "document.getElementById('star').textContent")) === '★', 'star filled', 3000).catch(() => {});
  check('the star shows the page is bookmarked', (await evalIn(ui, "document.getElementById('star').textContent")) === '★');

  // Export and import keep folders.
  tabs.openInternal('bookmarks');
  dialogTargets.save = path.join(work, 'exported-bookmarks.html');
  await inBookmarks("document.getElementById('bookmarksExport').click()");
  await waitFor(() => fs.existsSync(dialogTargets.save), 'bookmarks exported', 3000).catch(() => {});
  const exported = fs.existsSync(dialogTargets.save) ? fs.readFileSync(dialogTargets.save, 'utf8') : '';
  check('export writes folders into the bookmarks file', /PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar/.test(exported) &&
    /<H3>Work<\/H3>[\s\S]*Renamed B/.test(exported));
  dialogTargets.open = path.join(work, 'chrome-bookmarks.html');
  fs.writeFileSync(dialogTargets.open, `<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p>
    <DT><H3 PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3><DL><p>
      <DT><A HREF="${base}/bm-c">Duplicate</A>
      <DT><H3>Reading</H3><DL><p><DT><H3>Blogs</H3><DL><p><DT><A HREF="${base}/blog">Blog &amp; notes</A></DL><p></DL><p>
    </DL><p>
    <DT><A HREF="javascript:alert(1)">Bad</A>
    </DL><p>`);
  await inBookmarks("document.getElementById('bookmarksImport').click()");
  const readingFolder = () => settings.data.bookmarks.bar.children.find((node) => node.type === 'folder' && node.title === 'Reading');
  await waitFor(() => Boolean(readingFolder()), 'bookmarks imported', 3000).catch(() => {});
  const importMessage = await inBookmarks("document.getElementById('bookmarksMessage').textContent");
  check('import keeps folders, skipping duplicates and unsafe links',
    readingFolder()?.children[0]?.title === 'Blogs' && readingFolder().children[0].children[0]?.title === 'Blog & notes' &&
    /Imported 1 bookmark\. 1 skipped/.test(importMessage), importMessage);

  // Deleting a folder with bookmarks in it asks for a second click.
  await inBookmarks("document.querySelector('#bookmarkFolders [data-id=\"bar\"]').click()");
  await clickInBookmarkRow(workFolder().id, 'Delete');
  check('deleting a folder with bookmarks asks first', Boolean(workFolder()));
  await inBookmarks(`[...document.querySelector(${JSON.stringify(rowSelector(workFolder().id))}).querySelectorAll('button')].find((b) => /^Delete with/.test(b.textContent)).click()`);
  await waitFor(() => !workFolder(), 'folder deleted', 3000).catch(() => {});
  check('a folder and its bookmarks can be deleted', !workFolder() && !bookmarkTree.findLinkByUrl(settings.data.bookmarks, `${base}/starred`));
  settings.update({ bookmarks: [], bookmarkFolder: 'bar' });
  dialogTargets.save = '';
  dialogTargets.open = '';

  // ---------- Bookmarks bar: icons, », Other bookmarks, right-click, hiding ----------
  const barTab = tabs.order.map((id) => tabs.tabs.get(id)).find((tab) => tab.kind === 'web' && !tab.isPrivate);
  tabs.activate(barTab.id);
  await load(`${base}/icon-page`, barTab);
  await waitFor(() => barTab.favicon.startsWith('data:'), 'page icon', 8000).catch(() => {});
  actions.toggleBookmark();
  const barIconSrc = () => evalIn(ui, "document.querySelector('#bookmarks .chip .bm-icon')?.src ?? ''");
  await waitFor(async () => (await barIconSrc()).startsWith('data:image/png'), 'icon on the bar', 5000).catch(() => {});
  check('a bookmark shows its site icon on the bar', (await barIconSrc()).startsWith('data:image/png') &&
    ctx.bookmarkIcons.get(`${base}/icon-page`)?.startsWith('data:image/png'));

  settings.update({ bookmarks: {
    bar: { children: Array.from({ length: 40 }, (_, i) => ({ type: 'link', url: `${base}/many-${i}`, title: `Many bookmarks ${i}` })) },
    other: { children: [{ type: 'link', url: `${base}/kept-off`, title: 'Kept off the bar' }] },
  } });
  tabs.activate(barTab.id); // sends the toolbar fresh state
  const barLayout = () => evalIn(ui, `(() => {
    const more = document.querySelector('#bookmarks .more');
    return {
      hiddenIds: [...document.querySelectorAll('#bookmarks .chip[hidden]')].map((chip) => chip.dataset.id),
      more: Boolean(more && !more.hidden),
      other: document.querySelector('#bookmarks .chip.other')?.textContent ?? '',
    };
  })()`);
  await waitFor(async () => (await barLayout()).more, 'the » button', 5000).catch(() => {});
  const layout = await barLayout();
  const titleOf = (id) => bookmarkTree.find(settings.data.bookmarks, id)?.node.title;
  check('bookmarks that do not fit go under »', layout.more && layout.hiddenIds.length > 0 && layout.hiddenIds.length < 40, `${layout.hiddenIds.length} hidden`);
  check('the » menu lists exactly the hidden bookmarks',
    ctx.bookmarkMenus.items(layout.hiddenIds).map((item) => item.label).join('|') === layout.hiddenIds.map(titleOf).join('|'));
  check('Other bookmarks has its own button on the bar', /Other bookmarks/.test(layout.other), layout.other);

  const firstBookmark = settings.data.bookmarks.bar.children[0];
  const contextMenu = ctx.bookmarkMenus.context(firstBookmark.id);
  check('right-clicking a bookmark offers open, new tab, private tab, edit and delete',
    contextMenu.map((item) => item.label ?? '').join('|') === 'Open|Open in new tab|Open in private tab||Edit…|Delete');
  const tabsBefore = tabs.order.length;
  contextMenu.find((item) => item.label === 'Open in private tab').click();
  await waitFor(() => tabs.order.length === tabsBefore + 1 && tabs.active.isPrivate && tabs.active.view.webContents.getURL().endsWith('/many-0'), 'private tab from the menu', 5000).catch(() => {});
  check('a bookmark opens in a private tab from its menu', tabs.active.isPrivate && tabs.active.view.webContents.getURL().endsWith('/many-0'));
  tabs.close(tabs.activeId);

  contextMenu.find((item) => item.label === 'Edit…').click();
  const editField = `document.querySelector('#bookmarkList .bm-row[data-id="${firstBookmark.id}"] input[type=text]')`;
  await waitFor(async () => tabs.active.kind === 'internal' && (await evalIn(tabs.active.view, `Boolean(${editField})`)), 'bookmark ready to edit', 5000).catch(() => {});
  check('Edit… opens the bookmark ready to edit on the Bookmarks page', tabs.active.kind === 'internal' &&
    (await evalIn(tabs.active.view, `${editField}?.value ?? ''`)) === 'Many bookmarks 0');

  await contextMenu.find((item) => item.label === 'Delete').click();
  await waitFor(() => !bookmarkTree.find(settings.data.bookmarks, firstBookmark.id), 'bookmark deleted', 3000).catch(() => {});
  check('Delete in the menu removes the bookmark', !bookmarkTree.find(settings.data.bookmarks, firstBookmark.id));
  const otherMenu = ctx.bookmarkMenus.context('other').map((item) => item.label ?? '');
  check('Other bookmarks can be opened but not renamed or deleted', otherMenu.join('|') === 'Open all (1) in new tabs', otherMenu.join('|'));

  tabs.activate(barTab.id);
  actions.toggleBookmarksBar();
  await waitFor(() => ui.getBounds().height === 86, 'bar hidden', 3000).catch(() => {});
  check('Ctrl+Shift+B hides the bookmarks bar and the page moves up', settings.data.showBookmarksBar === false &&
    ui.getBounds().height === 86 && barTab.view.getBounds().y === 86, `toolbar ${ui.getBounds().height}, page at ${barTab.view.getBounds().y}`);
  actions.toggleBookmarksBar();
  await waitFor(() => ui.getBounds().height === 116, 'bar shown', 3000).catch(() => {});
  check('and shows it again', settings.data.showBookmarksBar === true && ui.getBounds().height === 116 && barTab.view.getBounds().y === 116);
  settings.update({ bookmarks: [], bookmarkFolder: 'bar' });
  tabs.activate(barTab.id);

  // ---------- Ad and tracker blocking ----------
  const adTab = tabs.create({ url: `${base}/ad-page` });
  await waitFor(() => adTab.view.webContents.getURL().endsWith('/ad-page') && !adTab.view.webContents.isLoading(), 'ad page loaded');
  const adState = (tab = adTab) => tab.view.webContents.executeJavaScript('JSON.stringify([window.adLoaded === true, window.appLoaded === true])');
  check("ads and trackers are blocked while the page's own script runs", (await adState()) === '[false,true]' && adRequests.length === 0,
    `${await adState()}, server saw ${adRequests.join(', ') || 'nothing'}`);
  const shieldText = () => evalIn(ui, "document.getElementById('shield').hidden ? '' : document.getElementById('shield').textContent");
  await waitFor(async () => (await shieldText()) === '🛡 2', 'shield count', 3000).catch(() => {});
  check('the shield in the address bar counts what was blocked', adTab.blocked === 2 && (await shieldText()) === '🛡 2', `${adTab.blocked}, ${await shieldText()}`);
  await evalIn(ui, "document.getElementById('shield').click()");
  await waitFor(async () => (await adState()) === '[true,true]', 'ads allowed after the shield click', 8000).catch(() => {});
  check('the shield allows ads and trackers on this site', settings.data.blockerAllowedSites.includes('127.0.0.1') && (await adState()) === '[true,true]' && (await shieldText()) === '🛡 off',
    `${settings.data.blockerAllowedSites.join(',')}, ${await adState()}, ${await shieldText()}`);
  await evalIn(ui, "document.getElementById('shield').click()");
  await waitFor(async () => !settings.data.blockerAllowedSites.length && (await adState()) === '[false,true]', 'blocked again', 8000).catch(() => {});
  check('clicking the shield again blocks them again', settings.data.blockerAllowedSites.length === 0 && (await adState()) === '[false,true]');
  const privateAdTab = tabs.create({ url: `${base}/ad-page`, isPrivate: true });
  await waitFor(() => privateAdTab.view.webContents.getURL().endsWith('/ad-page') && !privateAdTab.view.webContents.isLoading(), 'private ad page loaded');
  check('blocking also works in private tabs', (await adState(privateAdTab)) === '[false,true]');
  settings.update({ blockTrackers: false });
  adTab.view.webContents.reload();
  await waitFor(async () => (await adState()) === '[true,true]', 'blocking off', 8000).catch(() => {});
  check('turning blocking off in Settings lets everything load', (await adState()) === '[true,true]' && (await shieldText()) === '');
  settings.update({ blockTrackers: true });
  tabs.close(privateAdTab.id);
  tabs.close(adTab.id);

  // ---------- Updates ----------
  tabs.openInternal('settings');
  const settingsTab = tabs.active;
  await waitFor(() => settingsTab.title === 'Settings', 'settings page for updates');
  await evalIn(settingsTab.view, "document.getElementById('updatesCheck').click()");
  await waitFor(async () => /running from source/.test(await evalIn(settingsTab.view, "document.getElementById('updatesMessage').textContent")), 'update check answered', 5000).catch(() => {});
  check('a run from source never checks for updates', ctx.updates.mode === 'off' && /running from source/.test(await evalIn(settingsTab.view, "document.getElementById('updatesMessage').textContent")));
  check('automatic update checks are on by default', settings.data.checkForUpdates === true && (await evalIn(settingsTab.view, "document.getElementById('checkForUpdates').checked")) === true);

  // ---------- Print and Save as PDF ----------
  const pdfTab = tabs.order.map((id) => tabs.tabs.get(id)).find((tab) => tab.kind === 'web');
  tabs.activate(pdfTab.id);
  await load(`${base}/text`, pdfTab);
  dialogTargets.save = path.join(work, 'saved-page.pdf');
  const pdfPath = await actions.savePdf();
  const pdfBytes = pdfPath ? fs.readFileSync(pdfPath) : Buffer.alloc(0);
  check('a page can be saved as a PDF', pdfBytes.subarray(0, 5).toString() === '%PDF-' && pdfBytes.length > 1000, `${pdfBytes.length} bytes`);
  // The real print dialog cannot run in a test; check Print reaches the page.
  const printCalls = [];
  const realPrint = pdfTab.view.webContents.print;
  pdfTab.view.webContents.print = (options, callback) => { printCalls.push(options); callback(false, 'cancelled'); };
  actions.print();
  pdfTab.view.webContents.print = realPrint;
  check('Print opens the print dialog for the current page', printCalls.length === 1);
  tabs.openInternal('history');
  check('the browser pages are not printed or saved as PDF', (await actions.savePdf()) === null);
  dialogTargets.save = '';

  // ---------- Downloads policy ----------
  tabs.navigate(`${base}/setup.exe`);
  await waitFor(() => noticeLike(/Blocked download of "setup\.exe"/), 'executable download blocked', 8000);
  check('executable downloads are blocked with a message', true);
  check('a blocked download is not tracked as a download', ctx.downloads.list().length === 0);

  // A normal download is tracked and shown on the Downloads page.
  tabs.navigate(`${base}/report.txt`);
  await waitFor(() => ctx.downloads.list().some((d) => d.state === 'completed'), 'download completed', 10000);
  const downloaded = ctx.downloads.list()[0];
  check('a normal download completes and is tracked', downloaded.filename === 'report.txt' && downloaded.received === 18000,
    JSON.stringify(downloaded));
  check('the downloaded file is saved where expected', fs.existsSync(path.join(work, 'downloads', 'report.txt')));
  tabs.openInternal('downloads');
  const downloadsPage = tabs.active;
  await waitFor(() => downloadsPage.title === 'Downloads', 'downloads page');
  await waitFor(async () => (await evalIn(downloadsPage.view, "document.querySelectorAll('#downloadList .row').length")) === 1, 'download row');
  const rowText = await evalIn(downloadsPage.view, "document.querySelector('#downloadList .row').textContent");
  check('the downloads page lists the download as completed', /report\.txt/.test(rowText) && /Completed/.test(rowText) && /Show in folder/.test(rowText), rowText);

  // Newly blocked types, and a safe name changed to a blocked one in the Save dialog.
  tabs.navigate(`${base}/disk.iso`);
  await waitFor(() => noticeLike(/Blocked download of "disk\.iso"/), 'disk image download blocked', 8000);
  check('disk image downloads are blocked', !fs.existsSync(path.join(work, 'downloads', 'disk.iso')));
  tabs.navigate(`${base}/renamed.txt`);
  await waitFor(() => noticeLike(/Blocked download of "renamed\.exe"/), 'renamed download blocked', 10000);
  await waitFor(() => ctx.downloads.list()[0]?.filename === 'renamed.txt' && ctx.downloads.list()[0].state === 'blocked', 'renamed download marked blocked', 10000);
  // Cancelled, or deleted once it finished: either way the file goes away within moments.
  await waitFor(() => !fs.existsSync(path.join(work, 'downloads', 'renamed.exe')), 'renamed download removed', 5000).catch(() => {});
  check('a download renamed to a blocked type in the Save dialog is removed', !fs.existsSync(path.join(work, 'downloads', 'renamed.exe')));
  check('a renamed blocked download is not reported as complete', !noticeLike(/Download complete: renamed/));
  tabs.openInternal('downloads');
  await waitFor(async () => /Blocked/.test(await evalIn(downloadsPage.view, "document.querySelector('#downloadList .row').textContent")), 'blocked row shown');
  check('the downloads page shows the renamed download as blocked', true);

  // ---------- Recordings page ----------
  tabs.openInternal('recordings');
  const library = tabs.active;
  await waitFor(() => library.title === 'Recordings', 'recordings page');
  await waitFor(async () => (await evalIn(library.view, "document.querySelectorAll('#recList .row').length")) >= 1, 'recordings listed');
  const listed = await evalIn(library.view, 'window.browserApi.recordings.list().then((r) => r.entries.map((e) => e.name))');
  check('recordings page lists the screenshot', shot && listed.includes(path.basename(shot)), listed.join(','));
  const renamed = await evalIn(library.view, `window.browserApi.recordings.rename(${JSON.stringify(path.basename(shot))}, 'my shot')`);
  check('a recording can be renamed', renamed.ok && fs.existsSync(path.join(recordingsFolder, 'my shot.png')), JSON.stringify(renamed));
  const evil = await evalIn(library.view, "window.browserApi.recordings.rename('..\\\\..\\\\evil.png', 'x')");
  check('rename refuses names outside the recordings folder', evil.ok === false);
  tabs.activate(web.id);

  // ---------- Recording: pause ----------
  await load(`${base}/anim`, web);
  const wallStart = Date.now();
  await startRecording();
  await waitFor(() => recorder.active, 'recording started');
  await bytes.waitForMore('first recorded data');
  await sleep(1500);
  await evalIn(ui, "document.getElementById('recMark').click()"); // a marker from the toolbar's REC badge
  await sleep(1000);
  ui.webContents.send('recording:command', 'toggle-pause');
  await waitFor(() => recorder.paused, 'recording paused');
  const frozen = recorder.info;
  await sleep(2500);
  const badge = await evalIn(ui, "document.getElementById('recTime').textContent");
  check('pause freezes the timer and shows PAUSED', recorder.info.baseMs === frozen.baseMs && /^PAUSED/.test(badge), badge);
  ui.webContents.send('recording:command', 'toggle-pause');
  await waitFor(() => !recorder.paused, 'recording resumed');
  await sleep(1000);
  await evalIn(ctx.indicator, "document.getElementById('mark').click()"); // and one from the full-screen REC pill
  await sleep(1500);
  ui.webContents.send('recording:command', 'stop');
  await waitFor(() => !recorder.active, 'recording stopped');
  await sleep(500);
  const wall = Date.now() - wallStart;
  const pausedFiles = fs.readdirSync(recordingsFolder).filter((f) => f.endsWith('.webm'));
  const pausedName = pausedFiles[0];
  const length = recordingsIndex.get(pausedName);
  check('a paused recording is shorter than the elapsed time', length !== null && length > 3500 && length < wall - 1500, `${length} ms of ${wall} ms`);
  const pausedInfo = await inspectRecording(path.join(recordingsFolder, pausedName));
  check('a paused recording still plays', pausedInfo.width > 0 && pausedInfo.seconds > 1, JSON.stringify(pausedInfo));
  check('players see the recording length', pausedInfo.duration > 1 && Math.abs(pausedInfo.duration * 1000 - length) < 100,
    `${pausedInfo.duration} s in the file, ${length} ms listed`);
  check('the recording has a seek point at least every 2.5 s', pausedInfo.cuePoints >= Math.floor(pausedInfo.duration / 2.5) && pausedInfo.cuePoints >= 2,
    `${pausedInfo.cuePoints} points in ${pausedInfo.duration} s`);
  check('jumping to 70% of a recording works at once', Math.abs(pausedInfo.seekedTo - pausedInfo.seekTarget) < 0.1 && pausedInfo.seekMs < 2000,
    `to ${pausedInfo.seekedTo} s of ${pausedInfo.duration} s in ${pausedInfo.seekMs} ms`);
  // Markers line up with the file: the second one 1.5 s before Stop, and 2 s after the first
  // (1 s before the pause and 1 s after it; paused time does not count).
  const pausedMarkers = recordingsIndex.markersOf(pausedName);
  const pausedChapters = inspectWebm(fs.readFileSync(path.join(recordingsFolder, pausedName))).chapters ?? [];
  check('markers set while recording are kept with the recording', pausedMarkers.length === 2 &&
    Math.abs(pausedInfo.duration * 1000 - pausedMarkers[1] - 1500) < 700 && Math.abs(pausedMarkers[1] - pausedMarkers[0] - 2000) < 700,
    `${pausedMarkers.join(', ')} in ${pausedInfo.duration} s`);
  check('markers are written into the file as chapters', JSON.stringify(pausedChapters.map((c) => Math.round(c.ms))) === JSON.stringify(pausedMarkers) &&
    pausedChapters[1]?.name === 'Marker 2', JSON.stringify(pausedChapters));

  // ---------- Recordings page: thumbnails and the player ----------
  tabs.openInternal('recordings');
  const recPage = tabs.active;
  await waitFor(() => recPage.title === 'Recordings', 'recordings page (player)');
  const inRecPage = (script) => evalIn(recPage.view, script);
  const rowOf = (name) => `document.querySelector('.row[data-name="${name}"]')`;
  const thumbFrame = () => inRecPage(`(() => { const v = ${rowOf(pausedName)}?.querySelector('.thumb video'); return v ? v.readyState >= 2 && v.videoWidth > 0 : false; })()`);
  await waitFor(thumbFrame, 'thumbnail frame', 10000).catch(() => {});
  check('recordings show a thumbnail frame', await thumbFrame());
  await inRecPage(`[...${rowOf(pausedName)}.querySelectorAll('button')].find((b) => b.textContent === 'Play').click()`);
  const playerState = () => inRecPage(`(() => { const v = document.getElementById('playerMedia'); return v ? { time: v.currentTime, duration: v.duration, open: !document.getElementById('player').hidden } : null; })()`);
  await waitFor(async () => (await playerState())?.time > 0.3, 'player playing', 10000).catch(() => {});
  const playing = await playerState();
  check('the player plays the recording with its length', playing?.open && playing.time > 0.3 && Math.abs(playing.duration - pausedInfo.duration) < 0.2, JSON.stringify(playing));
  await inRecPage("(() => { const v = document.getElementById('playerMedia'); v.pause(); v.currentTime = v.duration * 0.8; })()");
  await waitFor(async () => { const s = await playerState(); return Math.abs(s.time - s.duration * 0.8) < 0.3; }, 'player seek', 5000).catch(() => {});
  const sought = await playerState();
  check('the player jumps within the recording', Math.abs(sought.time - sought.duration * 0.8) < 0.3, JSON.stringify(sought));
  const chips = await inRecPage("[...document.querySelectorAll('#playerMarkers button')].map((b) => b.textContent)");
  await inRecPage("document.querySelectorAll('#playerMarkers button')[1]?.click()");
  await waitFor(async () => Math.abs((await playerState()).time * 1000 - pausedMarkers[1]) < 300, 'jump to marker 2', 5000).catch(() => {});
  check('the player lists the markers and jumps to them', chips.length === 2 && /^Marker 2 · /.test(chips[1]) &&
    Math.abs((await playerState()).time * 1000 - pausedMarkers[1]) < 300, `${chips.join(' | ')}; at ${(await playerState()).time}`);
  await inRecPage("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))");
  check('Esc closes the player', (await inRecPage("document.getElementById('player').hidden")) === true);
  const someWebTab = tabs.order.map((id) => tabs.tabs.get(id)).find((tab) => tab.kind === 'web');
  const leaked = await someWebTab.view.webContents.executeJavaScript(
    `fetch('sb-media://recordings/${encodeURIComponent(pausedName)}').then(() => 'loaded', () => 'refused')`);
  check('web pages cannot load recordings', leaked === 'refused', leaked);

  // Trim from 2.5 s to 5 s with the player's own buttons.
  const pausedSize = fs.statSync(path.join(recordingsFolder, pausedName)).size;
  await inRecPage(`[...${rowOf(pausedName)}.querySelectorAll('button')].find((b) => b.textContent === 'Play').click()`);
  await waitFor(async () => (await inRecPage("document.getElementById('trimBar').hidden")) === false, 'trim bar', 5000);
  const seekPlayer = async (seconds) => {
    await inRecPage(`(() => { const v = document.getElementById('playerMedia'); v.pause(); v.currentTime = ${seconds}; })()`);
    await waitFor(async () => Math.abs((await playerState()).time - seconds) < 0.2, `player at ${seconds} s`, 5000);
  };
  await seekPlayer(2.5);
  await inRecPage("document.getElementById('trimStartSet').click()");
  await seekPlayer(5);
  await inRecPage("document.getElementById('trimEndSet').click()");
  await inRecPage("document.getElementById('trimSave').click()");
  const trimmedName = pausedName.replace(/\.webm$/, '-trimmed.webm');
  await waitFor(async () => /^Saved /.test(await inRecPage("document.getElementById('playerInfo').textContent")), 'trimmed copy saved', 20000).catch(() => {});
  const trimNote = await inRecPage("document.getElementById('playerInfo').textContent");
  const trimmedInfo = fs.existsSync(path.join(recordingsFolder, trimmedName)) ? await inspectRecording(path.join(recordingsFolder, trimmedName)) : {};
  check('a recording can be trimmed from the player', trimmedInfo.duration >= 2.4 && trimmedInfo.duration <= 5.1 && trimmedInfo.width > 0 && trimmedInfo.cuePoints >= 1,
    `${trimNote} | ${JSON.stringify(trimmedInfo)}`);
  // The copy starts at the last keyframe at or before 2.5 s and keeps the markers up to 5 s.
  const cutStart = (await keyframeTimes(path.join(recordingsFolder, pausedName))).filter((ms) => ms <= 2500).at(-1) ?? 0;
  const expectedMarkers = pausedMarkers.filter((ms) => ms >= cutStart && ms <= 5000).map((ms) => ms - cutStart);
  const trimmedMarkers = recordingsIndex.markersOf(trimmedName);
  check('the trimmed copy keeps the markers inside it', JSON.stringify(trimmedMarkers) === JSON.stringify(expectedMarkers),
    `${trimmedMarkers.join(', ')}; expected ${expectedMarkers.join(', ')} (cut at ${cutStart})`);
  check('the trimmed copy is listed with its length, and the original is kept',
    Math.abs((recordingsIndex.get(trimmedName) ?? 0) - trimmedInfo.duration * 1000) < 100 && fs.statSync(path.join(recordingsFolder, pausedName)).size === pausedSize);
  await inRecPage("document.getElementById('playerClose').click()");

  // ---------- Recording: quality ----------
  settings.update({ recordingQuality: 'low' });
  await sleep(300);
  const beforeLow = new Set(fs.readdirSync(recordingsFolder));
  await startRecording();
  await waitFor(() => recorder.active, 'low-quality recording started');
  await bytes.waitForMore('first low-quality data');
  await sleep(2000);
  ui.webContents.send('recording:command', 'stop');
  await waitFor(() => !recorder.active, 'low-quality recording stopped');
  await sleep(500);
  const lowName = fs.readdirSync(recordingsFolder).find((f) => f.endsWith('.webm') && !beforeLow.has(f));
  const lowInfo = await inspectRecording(path.join(recordingsFolder, lowName));
  check('low quality limits the video to 720p width', lowInfo.width > 0 && lowInfo.width <= 1280, JSON.stringify(lowInfo));
  settings.update({ recordingQuality: 'medium' });

  // ---------- Recording follows the active tab ----------
  const tabA = web;
  await load(`${base}/anim-a`, tabA);
  const beforeFiles = new Set(fs.readdirSync(recordingsFolder));
  await startRecording();
  await waitFor(() => recorder.active, 'follow recording started');
  await bytes.waitForMore('first data of the follow recording');
  await sleep(1500);
  const tabB = tabs.create({ url: `${base}/anim-b` });
  await waitFor(() => tabB.view.webContents.getURL().endsWith('/anim-b'), 'second tab loaded');
  await waitFor(() => recorder.session?.part === 2, 'recording moved to a second part');
  await bytes.waitForMore('data in the second part');
  await sleep(2000);
  check('the recording keeps going when the tab changes', recorder.active);
  ui.webContents.send('recording:command', 'stop');
  await waitFor(() => !recorder.active, 'follow recording stopped');
  await sleep(800);
  const newFiles = fs.readdirSync(recordingsFolder).filter((f) => f.endsWith('.webm') && !beforeFiles.has(f));
  const partTwoName = newFiles.find((f) => /-part2\.webm$/.test(f));
  check('switching tabs saves a second part', newFiles.length === 2 && Boolean(partTwoName), newFiles.join(', '));
  const sizes = newFiles.map((f) => fs.statSync(path.join(recordingsFolder, f)).size);
  check('both parts contain video', sizes.every((size) => size > 5000), sizes.join(', '));
  const partTwo = await inspectRecording(path.join(recordingsFolder, partTwoName ?? newFiles[0]));
  check('the second part plays', partTwo.width > 0 && partTwo.seconds > 1, JSON.stringify(partTwo));
  const partOne = await inspectRecording(path.join(recordingsFolder, newFiles.find((f) => f !== partTwoName) ?? newFiles[0]));
  check('both parts report their length to players', partOne.duration > 0.5 && partTwo.duration > 0.5,
    `${partOne.duration} s and ${partTwo.duration} s`);

  // Join the two parts from the Recordings page.
  const partOneName = newFiles.find((f) => f !== partTwoName);
  tabs.openInternal('recordings');
  const joinPage = tabs.active;
  const joinButton = `[...document.querySelector('.row[data-name="${partOneName}"]')?.querySelectorAll('button') ?? []].find((b) => /^Join 2 parts$/.test(b.textContent))`;
  await waitFor(async () => (await evalIn(joinPage.view, `Boolean(${joinButton})`)) === true, 'join button', 8000).catch(() => {});
  check('a recording in two parts offers to join them', (await evalIn(joinPage.view, `Boolean(${joinButton})`)) === true);
  await evalIn(joinPage.view, `${joinButton}?.click()`);
  const joinedName = partOneName.replace(/\.webm$/, '-joined.webm');
  await waitFor(() => fs.existsSync(path.join(recordingsFolder, joinedName)) && recordingsIndex.get(joinedName) !== null, 'joined recording', 20000).catch(() => {});
  const joinedInfo = fs.existsSync(path.join(recordingsFolder, joinedName)) ? await inspectRecording(path.join(recordingsFolder, joinedName)) : {};
  const joinMessage = await evalIn(joinPage.view, "document.getElementById('recMessage').textContent");
  check('the parts are joined into one recording as long as both',
    Math.abs(joinedInfo.duration - (partOne.duration + partTwo.duration)) < 0.3 && joinedInfo.width > 0 && joinedInfo.cuePoints >= 2,
    `${joinMessage} | ${JSON.stringify(joinedInfo)} | parts ${partOne.duration} s + ${partTwo.duration} s`);

  // ---------- Follow-tab switched off ----------
  settings.update({ recordingFollowTab: false });
  tabs.activate(tabA.id);
  const beforeOff = new Set(fs.readdirSync(recordingsFolder));
  await startRecording();
  await waitFor(() => recorder.active, 'recording started (follow off)');
  await bytes.waitForMore('first data (follow off)');
  await sleep(1000);
  tabs.activate(tabB.id);
  await sleep(2000);
  ui.webContents.send('recording:command', 'stop');
  await waitFor(() => !recorder.active, 'recording stopped (follow off)');
  await sleep(600);
  const offFiles = fs.readdirSync(recordingsFolder).filter((f) => f.endsWith('.webm') && !beforeOff.has(f));
  check('with follow off, switching tabs keeps a single file', offFiles.length === 1, offFiles.join(', '));
  settings.update({ recordingFollowTab: true });

  // ---------- Stop after a set time ----------
  settings.update({ recordingStopAfter: 5 }); // 5 test "minutes" = 3 s
  const beforeAutoStop = new Set(fs.readdirSync(recordingsFolder));
  tabs.activate(tabA.id);
  await startRecording();
  await waitFor(() => recorder.active, 'recording started (stop after)');
  await waitFor(async () => / \/ 00:03$/.test(await evalIn(ui, "document.getElementById('recTime').textContent")), 'limit on the badge', 3000).catch(() => {});
  const limitBadge = await evalIn(ui, "document.getElementById('recTime').textContent");
  await waitFor(() => !recorder.active, 'recording stopped by itself', 10000).catch(() => {});
  await sleep(500);
  const autoStoppedFile = fs.readdirSync(recordingsFolder).find((f) => f.endsWith('.webm') && !beforeAutoStop.has(f));
  const autoStoppedLength = autoStoppedFile ? recordingsIndex.get(autoStoppedFile) : null;
  check('a recording stops by itself after the time set in Settings', !recorder.active && autoStoppedLength > 500 && autoStoppedLength <= 3300 &&
    noticeLike(/stopped after 5 min, as set in Settings, and saved/), `${limitBadge}; ${autoStoppedLength} ms`);
  check('the REC badge shows the limit', / \/ 00:03$/.test(limitBadge), limitBadge);
  settings.update({ recordingStopAfter: 0 });

  // ---------- Microphone narration ----------
  const micWebTab = tabs.order.map((id) => tabs.tabs.get(id)).find((tab) => tab.kind === 'web');
  const askMicrophone = "navigator.mediaDevices.getUserMedia({ audio: true }).then((s) => { s.getTracks().forEach((t) => t.stop()); return 'granted'; }, (e) => e.name)";
  const pageMicrophone = await micWebTab.view.webContents.executeJavaScript(askMicrophone);
  check('web pages cannot use the microphone', pageMicrophone !== 'granted', pageMicrophone);
  const idleMicrophone = await evalIn(ui, askMicrophone);
  check('the toolbar cannot use the microphone when nothing is recording', idleMicrophone !== 'granted', idleMicrophone);
  settings.update({ recordingMicrophone: true });
  const beforeMicrophone = new Set(fs.readdirSync(recordingsFolder));
  const noticesBeforeMicrophone = notices.length;
  tabs.activate(tabA.id); // an animation page with no sound of its own
  await startRecording();
  await waitFor(() => recorder.active, 'recording started (microphone)');
  await bytes.waitForMore('first data (microphone)');
  await sleep(3000);
  ui.webContents.send('recording:command', 'stop');
  await waitFor(() => !recorder.active, 'recording stopped (microphone)');
  await sleep(500);
  const microphoneFile = fs.readdirSync(recordingsFolder).find((f) => f.endsWith('.webm') && !beforeMicrophone.has(f));
  const microphoneInfo = microphoneFile ? await inspectRecording(path.join(recordingsFolder, microphoneFile)) : {};
  check('narration records the microphone with a silent page, without clipping', microphoneInfo.audioPeak > 0.05 && microphoneInfo.audioPeak <= 1 &&
    !notices.slice(noticesBeforeMicrophone).some((text) => /microphone could not be used/.test(text)), JSON.stringify(microphoneInfo));
  settings.update({ recordingMicrophone: false });

  // ---------- Pause pressed while the recording moves to another tab ----------
  tabs.activate(tabA.id);
  await startRecording();
  await waitFor(() => recorder.active, 'recording started (pause while switching)');
  await bytes.waitForMore('first data (pause while switching)');
  const tabC = tabs.create({ url: `${base}/anim-c` });
  // Sent right after the switch started, so the toolbar is still moving the capture.
  ui.webContents.send('recording:command', 'toggle-pause');
  await waitFor(() => recorder.session?.part === 2, 'recording moved while pausing', 10000);
  await waitFor(async () => (await evalIn(ui, 'capture?.recorder.state ?? null')) === 'paused', 'new capture paused', 8000).catch(() => {});
  check('pause pressed during a tab switch is applied after it', recorder.paused && (await evalIn(ui, 'capture?.recorder.state ?? null')) === 'paused',
    `main paused=${recorder.paused}, capture ${await evalIn(ui, 'capture?.recorder.state ?? null')}`);
  ui.webContents.send('recording:command', 'stop');
  await waitFor(() => !recorder.active, 'recording stopped (pause while switching)');
  tabs.close(tabC.id);

  // ---------- Recording: a write error ends the recording ----------
  const beforeFail = new Set(fs.readdirSync(recordingsFolder));
  await startRecording();
  await waitFor(() => recorder.active, 'recording started (write error)');
  await bytes.waitForMore('first data (write error)');
  const noticesBeforeFail = notices.length;
  recorder.file.stream.destroy(Object.assign(new Error('disk full'), { code: 'ENOSPC' }));
  await waitFor(() => !recorder.active, 'recording ended after the write error', 8000);
  check('a write error stops the recording and tells the user', noticeLike(/Recording stopped: the file could not be written/));
  await sleep(800);
  const afterFail = notices.slice(noticesBeforeFail);
  check('a write error is not reported as a saved recording', !afterFail.some((text) => /^Recording saved/.test(text)), afterFail.join(' | '));
  const toolbarRecording = await evalIn(ui, "document.getElementById('record').classList.contains('recording')");
  check('the toolbar no longer shows a recording', toolbarRecording === false);
  const failFiles = fs.readdirSync(recordingsFolder).filter((f) => f.endsWith('.webm') && !beforeFail.has(f));
  check('a write error does not open a second file', failFiles.length <= 1, failFiles.join(', '));

  // ---------- Recording: closing the window keeps the last chunks ----------
  await sleep(500);
  const beforeClose = new Set(fs.readdirSync(recordingsFolder));
  await startRecording();
  await waitFor(() => recorder.active, 'recording started (window close)');
  await bytes.waitForMore('first data (window close)');
  await sleep(1500);
  let closedAt = 0;
  let acceptedAfterClose = 0;
  const countingWrite = recorder.write.bind(recorder);
  recorder.write = (chunk) => {
    const accepted = countingWrite(chunk);
    if (closedAt && accepted) acceptedAfterClose += 1;
    return accepted;
  };
  // Electron quits when its last window closes; keep running to report the results.
  app.on('window-all-closed', () => {});
  closedAt = Date.now();
  ctx.win.close();
  await waitFor(() => ctx.win.isDestroyed(), 'window closed while recording', 8000);
  check('closing the window while recording takes under 3 s', Date.now() - closedAt < 3000, `${Date.now() - closedAt} ms`);
  check('the last chunks are saved when the window closes', acceptedAfterClose >= 1, `${acceptedAfterClose} chunk(s) after close`);
  check('the recording is finished when the window closes', !recorder.active);
  const closeFiles = fs.readdirSync(recordingsFolder).filter((f) => f.endsWith('.webm') && !beforeClose.has(f));
  const closeInfo = closeFiles[0] ? await inspectRecording(path.join(recordingsFolder, closeFiles[0])) : {};
  check('the recording saved on close plays', closeInfo.width > 0 && closeInfo.seconds >= 1, JSON.stringify(closeInfo));

  server.close();
  const ok = finish();
  app.exit(ok ? 0 : 1);
}

main().catch((error) => {
  console.error('SMOKE ERROR', error);
  app.exit(2);
});
