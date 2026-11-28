'use strict';

// Smoke test for 0.15.0: spell checking, the new tab page's tiles, history by day, dark pages,
// and backing up and restoring.
// Run with: npm run smoke -- comfort.js
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { app, nativeTheme } = require('electron');
const { start, prepare } = require('../../src/main/app');
const bookmarkTree = require('../../src/main/bookmarks');
const { sleep, waitFor, createChecker, makeTempDir } = require('./helpers');

prepare();

const DAY = 24 * 60 * 60 * 1000;

async function main() {
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  app.on('window-all-closed', () => {});
  const { check, finish } = createChecker();
  const work = makeTempDir('sb-comfort-');

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    res.setHeader('content-type', 'text/html');
    if (url.pathname === '/light') {
      res.end('<!doctype html><title>Light</title><style>body { background: #fafafa; color: #222; }</style><p>light page</p><img id="pic" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">');
      return;
    }
    if (url.pathname === '/own-dark') {
      res.end('<!doctype html><title>Own dark</title><style>body { background: #fff; } @media (prefers-color-scheme: dark) { body { background: #121212; color: #eee; } }</style><p>has its own dark design</p>');
      return;
    }
    if (url.pathname === '/typing') {
      res.end('<!doctype html><title>Typing</title><textarea id="box"></textarea>');
      return;
    }
    const title = decodeURIComponent(url.pathname.split('/').pop() || 'Page');
    res.end(`<!doctype html><title>${title}</title>${title}`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  // The Save and Open dialogs answer with the files the test names.
  const files = { save: null, open: null };
  const { dialog: realDialog } = require('electron');
  const dialog = {
    showMessageBox: async () => ({ response: 0 }),
    showSaveDialog: async () => (files.save ? { canceled: false, filePath: files.save } : { canceled: true }),
    showOpenDialog: async () => (files.open ? { canceled: false, filePaths: [files.open] } : { canceled: true, filePaths: [] }),
    showErrorBox: (...args) => realDialog.showErrorBox(...args),
  };
  const ctx = await start({ userDataDir: path.join(work, 'profile'), skipSingleInstanceLock: true, blockerFilters: '', quitOnClose: false, dialog });
  const { tabs, ui, history, settings, darkPages } = ctx;
  await waitFor(() => ctx.win.isVisible() && !ui.webContents.isLoading(), 'window ready', 30000);
  const evalIn = (contents, code) => contents.executeJavaScript(code);
  const load = async (url, tab = tabs.active) => {
    tab.view.webContents.loadURL(url).catch(() => {});
    await waitFor(() => tab.view.webContents.getURL() === url && !tab.view.webContents.isLoading(), `load ${url}`);
  };
  const settingsPage = async () => {
    tabs.openInternal('settings');
    const page = tabs.active.view.webContents;
    await waitFor(() => tabs.active.title === 'Settings' && !page.isLoading(), 'settings page');
    await waitFor(async () => evalIn(page, "document.getElementById('folderPath').textContent !== ''"), 'settings shown');
    return page;
  };
  const tick = (page, id, on) => evalIn(page, `(() => { const box = document.getElementById(${JSON.stringify(id)}); if (box.checked !== ${on}) box.click(); })()`);

  // ---------- The new tab page ----------
  settings.update({ historyEnabled: true });
  // Visits as history keeps them: three to one page, two to another, one to a third.
  history.entries = ['Often', 'Sometimes', 'Often', 'Once', 'Sometimes', 'Often']
    .map((name, index) => ({ id: index + 1, url: `${base}/page/${name}`, title: name, time: Date.now() - (10 - index) * 60_000 }));
  history.nextId = 7;
  const barTree = bookmarkTree.addLink(settings.data.bookmarks, 'bar', { title: 'Docs', url: `${base}/page/Docs` }).tree;
  settings.update({ bookmarks: barTree });
  const newTab = async (isPrivate = false) => {
    const tab = tabs.create({ isPrivate });
    await waitFor(() => /newtab\.html/.test(tab.view.webContents.getURL()) && !tab.view.webContents.isLoading(), 'new tab page');
    return tab;
  };
  let tab = await newTab();
  const tilesOf = (contents) => evalIn(contents, `(() => ({
    top: [...document.querySelectorAll('#topTiles .tile')].map((t) => t.querySelector('.label').textContent),
    bookmarks: [...document.querySelectorAll('#bookmarkTiles .tile')].map((t) => t.querySelector('.label').textContent),
    topShown: !document.getElementById('topSection').hidden,
    search: document.activeElement?.name === 'q' || document.querySelector('input[name=q]') !== null,
  }))()`);
  let tiles = await tilesOf(tab.view.webContents);
  check('the new tab page shows the most visited pages, most visited first', JSON.stringify(tiles.top.slice(0, 3)) === '["Often","Sometimes","Once"]', JSON.stringify(tiles));
  check('and the bookmarks bar, with the search box ready', tiles.bookmarks.includes('Docs') && tiles.search, JSON.stringify(tiles));
  check('the tiles are drawn as text: icons are letters, no web requests', (await evalIn(tab.view.webContents, "document.querySelector('#topTiles .tile .icon').textContent")) === '1');
  await evalIn(tab.view.webContents, "document.querySelector('#topTiles .tile .remove').click()");
  await waitFor(() => settings.data.newTabHidden.length === 1, 'tile hidden', 5000).catch(() => {});
  check('removing a tile keeps it off the page', settings.data.newTabHidden[0] === `${base}/page/Often` && (await tilesOf(tab.view.webContents)).top[0] === 'Sometimes', JSON.stringify(settings.data.newTabHidden));
  tabs.close(tab.id);
  tab = await newTab();
  tiles = await tilesOf(tab.view.webContents);
  check('a removed tile stays away on the next new tab', !tiles.top.includes('Often') && tiles.top[0] === 'Sometimes', JSON.stringify(tiles));
  tabs.close(tab.id);
  const privateTab = await newTab(true);
  tiles = await tilesOf(privateTab.view.webContents);
  check('a private tab never shows the most visited pages', tiles.top.length === 0 && !tiles.topShown && tiles.bookmarks.includes('Docs'), JSON.stringify(tiles));
  tabs.close(privateTab.id);
  settings.update({ historyEnabled: false });
  tab = await newTab();
  tiles = await tilesOf(tab.view.webContents);
  check('with history off, no most visited pages are shown', tiles.top.length === 0, JSON.stringify(tiles));
  // A website can't hide tiles by setting #hide on itself.
  await load(`${base}/page/Sneaky`, tab);
  await evalIn(tab.view.webContents, `location.hash = 'hide=' + encodeURIComponent('${base}/page/Sometimes')`);
  await sleep(400);
  check('a web page setting #hide hides nothing', settings.data.newTabHidden.length === 1);
  settings.update({ historyEnabled: true });

  // ---------- History by day ----------
  const now = Date.now();
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const today = Math.min(now - 1000, midnight.getTime() + 60 * 1000);
  history.entries = [
    { url: `${base}/page/Older`, title: 'Older one', time: midnight.getTime() - 3 * DAY + 3600_000 },
    { url: `${base}/page/Yesterday1`, title: 'Yesterday news', time: midnight.getTime() - DAY + 3600_000 },
    { url: `${base}/page/Yesterday2`, title: 'Yesterday mail', time: midnight.getTime() - DAY + 7200_000 },
    { url: `${base}/page/Today`, title: 'Today news', time: today },
  ].map((entry, index) => ({ ...entry, id: index + 1 }));
  history.nextId = 5;
  tabs.openInternal('history');
  const historyPage = tabs.active.view.webContents;
  await waitFor(() => tabs.active.title === 'History' && !historyPage.isLoading(), 'history page');
  const days = () => evalIn(historyPage, "[...document.querySelectorAll('#historyList .day')].map((d) => d.querySelector('h3').textContent + ':' + d.querySelectorAll('.row').length)");
  await waitFor(async () => (await days()).length === 3, 'days listed', 5000).catch(() => {});
  const listed = await days();
  check('history is shown by day: Today, Yesterday, then the day', listed[0] === 'Today:1' && listed[1] === 'Yesterday:2' && /^\w+day, \d+ \w+:1$|^\w+day \d+ \w+:1$|^\w+day, \w+ \d+:1$/.test(listed[2]), JSON.stringify(listed));
  await evalIn(historyPage, "(() => { const s = document.getElementById('historySearch'); s.value = 'news'; s.dispatchEvent(new Event('input')); })()");
  await waitFor(async () => (await days()).join() === 'Today:1,Yesterday:1', 'search keeps days', 5000).catch(() => {});
  check('a search keeps the days', (await days()).join() === 'Today:1,Yesterday:1', JSON.stringify(await days()));
  // While searching, only the pages found that day go.
  await evalIn(historyPage, "document.querySelectorAll('.day')[1].querySelector('.day-delete').click()");
  const asked = await evalIn(historyPage, "document.querySelectorAll('.day')[1].querySelector('.confirm-text')?.textContent ?? ''");
  check('deleting asks on the page first', /Delete the 1 page found yesterday\?/.test(asked) && history.entries.length === 4, asked);
  await evalIn(historyPage, "document.querySelectorAll('.day')[1].querySelector('.day-tools button.danger').click()");
  await waitFor(() => history.entries.length === 3, 'found pages deleted', 5000).catch(() => {});
  check('while searching, only the pages found that day are deleted', JSON.stringify(history.entries.map((e) => e.title)) === '["Older one","Yesterday mail","Today news"]', JSON.stringify(history.entries.map((e) => e.title)));
  await evalIn(historyPage, "(() => { const s = document.getElementById('historySearch'); s.value = ''; s.dispatchEvent(new Event('input')); })()");
  await waitFor(async () => (await days()).length === 3, 'all days again');
  // Cancel keeps the day.
  await evalIn(historyPage, "document.querySelectorAll('.day')[1].querySelector('.day-delete').click()");
  await evalIn(historyPage, "[...document.querySelectorAll('.day')[1].querySelectorAll('.day-tools button')].find((b) => b.textContent === 'Cancel').click()");
  check('Cancel keeps the day', history.entries.length === 3 && (await evalIn(historyPage, "Boolean(document.querySelectorAll('.day')[1].querySelector('.day-delete'))")));
  await evalIn(historyPage, "document.querySelectorAll('.day')[1].querySelector('.day-delete').click()");
  await evalIn(historyPage, "document.querySelectorAll('.day')[1].querySelector('.day-tools button.danger').click()");
  await waitFor(async () => (await days()).length === 2, 'day deleted', 5000).catch(() => {});
  check('Delete this day removes that day only', JSON.stringify(history.entries.map((e) => e.title)) === '["Older one","Today news"]' && (await days())[0] === 'Today:1', JSON.stringify(await days()));
  // The page can only name a time range, not delete anything else.
  const refused = await evalIn(historyPage, "window.browserApi.history.removeRange(10, 5).then(() => 'ran', () => 'refused')");
  check('a backwards time range is refused', refused === 'refused');
  // The pages opened below are not kept in history.
  settings.update({ historyEnabled: false });

  // ---------- Spell checking ----------
  const typing = tabs.create({ url: `${base}/typing` });
  await waitFor(() => !typing.view.webContents.isLoading() && typing.title === 'Typing', 'typing page');
  const regular = typing.view.webContents.session;
  check('spell checking is on by default', regular.isSpellCheckerEnabled() === true);
  let page = await settingsPage();
  check('Settings shows the spell checking setting, on', await evalIn(page, "document.getElementById('spellcheck').checked"));
  await tick(page, 'spellcheck', false);
  await waitFor(() => settings.data.spellcheck === false, 'spellcheck off');
  check('turning spell checking off applies to open tabs at once', regular.isSpellCheckerEnabled() === false);
  const privateTyping = tabs.create({ url: `${base}/typing`, isPrivate: true, activate: false });
  await waitFor(() => !privateTyping.view.webContents.isLoading(), 'private typing page');
  check('and to tabs opened after', privateTyping.view.webContents.session.isSpellCheckerEnabled() === false);
  await tick(page, 'spellcheck', true);
  await waitFor(() => settings.data.spellcheck === true, 'spellcheck on');
  check('turning it on again does too', regular.isSpellCheckerEnabled() && privateTyping.view.webContents.session.isSpellCheckerEnabled());
  tabs.close(privateTyping.id);
  tabs.close(typing.id);

  // ---------- Dark pages ----------
  const light = tabs.create({ url: `${base}/light` });
  await waitFor(() => !light.view.webContents.isLoading() && light.title === 'Light', 'light page');
  const ownDark = tabs.create({ url: `${base}/own-dark`, activate: false });
  await waitFor(() => !ownDark.view.webContents.isLoading() && ownDark.title === 'Own dark', 'own dark page');
  const filterOf = (contents) => evalIn(contents, 'getComputedStyle(document.documentElement).filter');
  check('dark pages are off by default: pages are as they are', (await filterOf(light.view.webContents)) === 'none' && nativeTheme.themeSource === 'system');
  page = await settingsPage();
  await tick(page, 'darkPages', true);
  await waitFor(() => darkPages.isDarkened(light.view.webContents), 'light page darkened', 8000).catch(() => {});
  check('turning dark pages on darkens a light page at once', /invert/.test(await filterOf(light.view.webContents)), await filterOf(light.view.webContents));
  check('pictures are turned back, so they look as they are', /invert/.test(await evalIn(light.view.webContents, "getComputedStyle(document.getElementById('pic')).filter")));
  await sleep(500);
  const ownBackground = await evalIn(ownDark.view.webContents, 'getComputedStyle(document.body).backgroundColor');
  check('a site with its own dark design uses it, and is not inverted', nativeTheme.themeSource === 'dark' && ownBackground === 'rgb(18, 18, 18)' && !darkPages.isDarkened(ownDark.view.webContents), `${nativeTheme.themeSource} ${ownBackground}`);
  // A page loaded later is darkened when it loads.
  const later = tabs.create({ url: `${base}/light?later` });
  await waitFor(() => !later.view.webContents.isLoading(), 'later page');
  await waitFor(() => darkPages.isDarkened(later.view.webContents), 'later darkened', 8000).catch(() => {});
  check('pages opened later are darkened too', darkPages.isDarkened(later.view.webContents));
  tabs.close(later.id);
  // Keep this site light, from the site info panel.
  tabs.activate(light.id);
  // The toolbar closes the panel when it hears of another tab: open it once it knows.
  await waitFor(async () => (await evalIn(ui.webContents, 'state.activeId')) === light.id, 'toolbar on the light tab');
  await evalIn(ui.webContents, "document.getElementById('security').click()");
  await waitFor(async () => evalIn(ui.webContents, "Boolean(document.getElementById('siteDark'))"), 'dark row', 8000).catch(() => {});
  const row = await evalIn(ui.webContents, "document.getElementById('sitePanel').textContent");
  check('the site info panel offers to keep the site light', /Dark pages: darkened/.test(row) && /Keep this site light/.test(row),
    `${row.slice(0, 300)} ${JSON.stringify(await evalIn(ui.webContents, 'window.browserApi.site.info().then((i) => i && i.dark, (e) => String(e))'))}`);
  await evalIn(ui.webContents, "document.getElementById('siteDark').click()");
  await waitFor(() => settings.data.darkPagesLight.includes('127.0.0.1'), 'kept light', 5000).catch(() => {});
  await waitFor(async () => (await filterOf(light.view.webContents)) === 'none', 'light again', 5000).catch(() => {});
  check('Keep this site light shows it as it is', settings.data.darkPagesLight.includes('127.0.0.1') && (await filterOf(light.view.webContents)) === 'none');
  await waitFor(async () => /kept light here/.test(await evalIn(ui.webContents, "document.getElementById('sitePanel').textContent")), 'panel redrawn', 5000).catch(() => {});
  check('the panel then offers to make it dark again', /Make dark/.test(await evalIn(ui.webContents, "document.getElementById('sitePanel').textContent")));
  await evalIn(ui.webContents, "document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))");
  page = await settingsPage();
  await waitFor(async () => evalIn(page, "Boolean(document.querySelector('#darkSites .row[data-site=\"127.0.0.1\"]'))"), 'kept-light site listed', 5000).catch(() => {});
  check('Settings lists the sites kept light', await evalIn(page, "Boolean(document.querySelector('#darkSites .row[data-site=\"127.0.0.1\"]'))"));
  await evalIn(page, "document.querySelector('#darkSites .row[data-site=\"127.0.0.1\"] button').click()");
  await waitFor(() => darkPages.isDarkened(light.view.webContents), 'dark again', 8000).catch(() => {});
  check('Make dark again darkens it again', settings.data.darkPagesLight.length === 0 && darkPages.isDarkened(light.view.webContents));
  await tick(page, 'darkPages', false);
  await waitFor(async () => (await filterOf(light.view.webContents)) === 'none', 'undarkened', 5000).catch(() => {});
  check('turning dark pages off puts every page back', (await filterOf(light.view.webContents)) === 'none' && nativeTheme.themeSource === 'system');
  tabs.close(ownDark.id);

  // ---------- Back up and restore ----------
  const pinned = tabs.create({ url: `${base}/page/Mail` });
  await waitFor(() => !pinned.view.webContents.isLoading(), 'mail page');
  tabs.pin(pinned.id, true);
  await waitFor(() => settings.data.pinnedTabs.includes(`${base}/page/Mail`), 'pinned saved', 5000);
  settings.update({ searchEngine: 'duckduckgo' });
  page = await settingsPage();
  files.save = path.join(work, 'backup.json');
  await tick(page, 'backupHistory', true);
  await evalIn(page, "document.getElementById('backupSave').click()");
  await waitFor(async () => evalIn(page, "!document.getElementById('backupMessage').hidden"), 'backed up', 8000);
  const saved = JSON.parse(fs.readFileSync(files.save, 'utf8'));
  check('Back up saves bookmarks, settings, pinned tabs and, when ticked, history', saved.format === 'simple-browser-backup' &&
    bookmarkTree.links(saved.bookmarks).some((link) => link.title === 'Docs') && saved.settings.searchEngine === 'duckduckgo' &&
    saved.pinnedTabs.includes(`${base}/page/Mail`) && Array.isArray(saved.history) && saved.history.length === 2, Object.keys(saved).join());
  check('a backup has no cookies, session or folders of this computer', !('cookies' in saved) && saved.settings.session === undefined && saved.settings.recordingFolder === undefined);

  // Things change after the backup...
  settings.update({ bookmarks: bookmarkTree.emptyTree(), searchEngine: 'bing' });
  tabs.close(pinned.id);
  await waitFor(() => settings.data.pinnedTabs.length === 0, 'unpinned saved', 5000);
  // ... a file that isn't a backup is refused ...
  files.open = path.join(work, 'not-a-backup.json');
  fs.writeFileSync(files.open, '{"hello": 1}');
  await evalIn(page, "document.getElementById('backupOpen').click()");
  await waitFor(async () => /not a Simple Browser backup/.test(await evalIn(page, "document.getElementById('backupMessage').textContent")), 'refused', 5000).catch(() => {});
  check('a file that is not a backup is refused', /not a Simple Browser backup/.test(await evalIn(page, "document.getElementById('backupMessage').textContent")) &&
    (await evalIn(page, "document.getElementById('restorePreview').hidden")));
  // ... and the backup shows what it holds before anything changes.
  files.open = files.save;
  await evalIn(page, "document.getElementById('backupOpen').click()");
  await waitFor(async () => evalIn(page, "!document.getElementById('restorePreview').hidden"), 'preview', 5000);
  const preview = await evalIn(page, "[...document.querySelectorAll('#restoreParts label')].map((l) => l.textContent.trim())");
  check('restore shows what the file holds first', preview.some((text) => /^Bookmarks \(1 bookmark, 0 folders\)$/.test(text)) && preview.includes('Settings') &&
    preview.includes('Pinned tabs (1)') && preview.some((text) => /^History \(2 visits\)$/.test(text)), JSON.stringify(preview));
  check('nothing changes until Restore is pressed', settings.data.searchEngine === 'bing' && bookmarkTree.links(settings.data.bookmarks).length === 0);
  await evalIn(page, "document.querySelector('#restoreParts input[data-part=\"history\"]').click()");
  await evalIn(page, "document.getElementById('restoreConfirm').click()");
  await waitFor(async () => /^Restored/.test(await evalIn(page, "document.getElementById('backupMessage').textContent")), 'restored', 8000);
  const restoredMessage = await evalIn(page, "document.getElementById('backupMessage').textContent");
  check('Restore puts back the parts chosen', settings.data.searchEngine === 'duckduckgo' && bookmarkTree.links(settings.data.bookmarks).some((link) => link.title === 'Docs'), restoredMessage);
  await waitFor(() => tabs.pinnedUrls().includes(`${base}/page/Mail`), 'pinned tab back', 8000).catch(() => {});
  check('the pinned tab comes back, pinned', tabs.pinnedUrls().includes(`${base}/page/Mail`), JSON.stringify(tabs.pinnedUrls()));
  await waitFor(() => settings.data.pinnedTabs.includes(`${base}/page/Mail`), 'pinned tab saved', 5000).catch(() => {});
  check('and is kept for the next start', settings.data.pinnedTabs.includes(`${base}/page/Mail`), JSON.stringify(settings.data.pinnedTabs));
  check('history was left alone, as it was not ticked', history.entries.length === 2 && !/history/.test(restoredMessage), restoredMessage);
  check('the page says what was restored', /^Restored 1 bookmark, your settings, 1 pinned tab opened/.test(restoredMessage), restoredMessage);
  check('the Settings page shows the restored settings', (await evalIn(page, "document.getElementById('searchEngine').value")) === 'duckduckgo');
  // A restore without opening a file first does nothing.
  const again = await evalIn(page, "window.browserApi.settings.backupRestore({ bookmarks: true })");
  check('restoring twice needs the file opened again', again.ok === false);

  ctx.win.destroy();
  server.close();
  const ok = finish();
  app.exit(ok ? 0 : 1);
}

main().catch((error) => {
  console.error('SMOKE ERROR', error);
  app.exit(2);
});
