'use strict';

// Smoke test for the everyday features of 0.13.0: the crashed-tab page, the site info panel
// (and clearing one site's data), tab search, and clearing browsing data over a time range.
// Run with: npm run smoke -- everyday.js
const http = require('node:http');
const path = require('node:path');
const { app } = require('electron');
const { start, prepare } = require('../../src/main/app');
const { sleep, waitFor, createChecker, makeTempDir } = require('./helpers');

prepare();

async function main() {
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  app.on('window-all-closed', () => {});
  const { check, finish } = createChecker();
  const work = makeTempDir('sb-everyday-');

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    res.setHeader('content-type', 'text/html');
    if (url.pathname === '/cookies') {
      res.setHeader('set-cookie', [`sid-${url.searchParams.get('n') ?? '1'}=abc; Path=/; Max-Age=86400`, 'pref=dark; Path=/; Max-Age=86400']);
      res.end('<!doctype html><title>Cookies</title><script>localStorage.setItem("kept", "yes");</script>cookies');
      return;
    }
    if (url.pathname === '/asks') {
      res.end('<!doctype html><title>Asks</title><script>navigator.geolocation.getCurrentPosition(() => {}, () => { document.title = "Asked"; });</script>asks');
      return;
    }
    const title = decodeURIComponent(url.pathname.split('/').pop() || 'Page');
    res.end(`<!doctype html><title>${title}</title>${title}`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const otherBase = `http://localhost:${port}`;

  // The confirmation before clearing a site's data: answered as the test says.
  let confirmAnswer = 0;
  const confirms = [];
  const { dialog: realDialog } = require('electron');
  const dialog = {
    showMessageBox: async (_win, options) => { confirms.push(options.message); return { response: confirmAnswer }; },
    showSaveDialog: async () => ({ canceled: true }),
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showErrorBox: (...args) => realDialog.showErrorBox(...args),
  };
  const ctx = await start({ userDataDir: path.join(work, 'profile'), skipSingleInstanceLock: true, blockerFilters: '', quitOnClose: false, dialog });
  const { tabs, ui, history, settings } = ctx;
  await waitFor(() => ctx.win.isVisible() && !ui.webContents.isLoading(), 'window ready', 30000);
  const evalIn = (contents, code) => contents.executeJavaScript(code);
  const active = () => tabs.snapshot().find((tab) => tab.id === tabs.activeId);
  const load = async (url, tab = tabs.active) => {
    tab.view.webContents.loadURL(url).catch(() => {});
    await waitFor(() => tab.view.webContents.getURL() === url && !tab.view.webContents.isLoading(), `load ${url}`);
  };

  // ---------- A crashed tab ----------
  const crashTab = tabs.active;
  await load(`${base}/page/Maps`, crashTab);
  crashTab.view.webContents.forcefullyCrashRenderer();
  await waitFor(() => active()?.crashed && /crashed\.html/.test(crashTab.view.webContents.getURL()) && !crashTab.view.webContents.isLoading(), 'crash page shown');
  check('a crashed page shows the crash page, with the page’s address kept', active().url === `${base}/page/Maps` && active().title === 'Page crashed', JSON.stringify(active()));
  const crashText = await evalIn(crashTab.view.webContents, 'document.body.innerText');
  check('the crash page names the site and says what happened', crashText.includes(`127.0.0.1:${port}`) && /This page crashed/.test(crashText), crashText.slice(0, 120));
  check('the tab shows a warning mark instead of its icon', await evalIn(ui.webContents, "Boolean(document.querySelector('#tabs .tab.active svg.fav.crashed'))"));
  check('the crash page gets no bridge to the browser', (await evalIn(crashTab.view.webContents, 'typeof window.browserApi')) === 'undefined');
  await evalIn(crashTab.view.webContents, "document.getElementById('reload').click()");
  await waitFor(() => crashTab.view.webContents.getURL() === `${base}/page/Maps` && !crashTab.view.webContents.isLoading(), 'reloaded after the crash');
  check('Reload on the crash page loads the page again', !active().crashed && active().title === 'Maps');
  // A web page can't use the crash page's buttons on its own tab.
  await load(`${base}/page/Sneaky`, crashTab);
  await evalIn(crashTab.view.webContents, "location.hash = 'close'");
  await sleep(500);
  check('a web page setting #close does not close its tab', tabs.tabs.has(crashTab.id));
  crashTab.view.webContents.forcefullyCrashRenderer();
  await waitFor(() => active()?.crashed && !crashTab.view.webContents.isLoading(), 'crash page again');
  const keep = tabs.create({ url: `${base}/page/Keep`, activate: false });
  tabs.activate(crashTab.id);
  await evalIn(crashTab.view.webContents, "document.getElementById('close').click()");
  await waitFor(() => !tabs.tabs.has(crashTab.id), 'crashed tab closed', 5000).catch(() => {});
  check('Close tab on the crash page closes the tab', !tabs.tabs.has(crashTab.id));
  tabs.activate(keep.id);
  await waitFor(() => !keep.view.webContents.isLoading(), 'keep tab');

  // ---------- Site info ----------
  const site = tabs.active;
  await load(`${otherBase}/cookies?n=other`, site);
  await load(`${base}/cookies?n=1`, site);
  await waitFor(async () => evalIn(ui.webContents, "!document.getElementById('security').hidden"), 'site info button');
  const button = await evalIn(ui.webContents, "document.getElementById('security').textContent + '|' + document.getElementById('security').getAttribute('aria-label')");
  check('an http page shows "Not secure" at the start of the address bar', /Not secure\|Not secure\. Site info for 127\.0\.0\.1/.test(button), button);
  await evalIn(ui.webContents, "document.getElementById('security').click()");
  await waitFor(async () => /cookies? ·/.test(await evalIn(ui.webContents, "document.getElementById('sitePanel').textContent")), 'site panel', 8000);
  let panel = await evalIn(ui.webContents, "document.getElementById('sitePanel').textContent");
  check('the panel says the connection is not secure, and counts this site’s cookies only', /Connection is not secure/.test(panel) && /2 cookies ·/.test(panel) && /open the secure version/.test(panel), panel.slice(0, 260));
  // The panel hangs below the bars: the toolbar's view must grow to show it, or it is cut off.
  check('the panel is shown in full: the toolbar makes room for it below the bars', ui.getBounds().height >= 116 + 250, `toolbar view ${ui.getBounds().height}px`);
  await evalIn(ui.webContents, "document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))");

  await load(`${base}/asks`, site);
  await waitFor(() => site.title === 'Asked', 'location refused', 8000).catch(() => {});
  await evalIn(ui.webContents, "document.getElementById('security').click()");
  await waitFor(async () => /Your location/.test(await evalIn(ui.webContents, "document.getElementById('sitePanel').textContent")), 'permission listed', 8000).catch(() => {});
  panel = await evalIn(ui.webContents, "document.getElementById('sitePanel').textContent");
  check('what the page asked for is listed, and that it was blocked', /Your locationBlocked/.test(panel), panel.slice(0, 300));

  // Clear data: asks first; Cancel clears nothing.
  const session = site.view.webContents.session;
  const cookiesOf = async (host) => (await session.cookies.get({})).filter((c) => c.domain === host).map((c) => c.name).sort();
  confirmAnswer = 1;
  await evalIn(ui.webContents, "document.getElementById('siteClear').click()");
  await waitFor(() => confirms.length === 1, 'confirmation asked');
  await sleep(300);
  check('Clear data asks first, and Cancel clears nothing', /Clear cookies and site data for 127\.0\.0\.1\?/.test(confirms[0]) && (await cookiesOf('127.0.0.1')).length === 2, confirms[0]);
  confirmAnswer = 0;
  if (!(await evalIn(ui.webContents, "!document.getElementById('sitePanel').hidden"))) await evalIn(ui.webContents, "document.getElementById('security').click()");
  await waitFor(async () => evalIn(ui.webContents, "Boolean(document.getElementById('siteClear')) && !document.getElementById('siteClear').disabled"), 'clear button ready');
  await evalIn(ui.webContents, "document.getElementById('siteClear').click()");
  await waitFor(async () => (await cookiesOf('127.0.0.1')).length === 0, 'site cookies cleared', 8000).catch(() => {});
  check('Clear data removes this site’s cookies', (await cookiesOf('127.0.0.1')).length === 0);
  check('...and leaves other sites’ cookies alone', JSON.stringify(await cookiesOf('localhost')) === '["pref","sid-other"]', JSON.stringify(await cookiesOf('localhost')));
  await load(`${base}/page/Storage`, site);
  check('...and what the site stored (local storage) is gone too', (await evalIn(site.view.webContents, "localStorage.getItem('kept')")) === null);
  await load(`${otherBase}/page/Storage`, site);
  check('...but not another site’s', (await evalIn(site.view.webContents, "localStorage.getItem('kept')")) === 'yes');
  await evalIn(ui.webContents, "document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))");

  // ---------- Tab search ----------
  const titles = ['Recipes everyone should know', 'Grandma recipes', 'Flights to Oslo'];
  const made = titles.map((title) => tabs.create({ url: `${base}/page/${encodeURIComponent(title)}`, activate: false }));
  await waitFor(() => made.every((tab) => titles.includes(tab.title)), 'tabs titled');
  tabs.activate(site.id);
  ctx.win.focus();
  site.view.webContents.focus();
  site.view.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control', 'shift'] });
  await waitFor(async () => evalIn(ui.webContents, "!document.getElementById('tabSearchPanel').hidden"), 'tab search open', 5000).catch(() => {});
  check('Ctrl+Shift+A opens tab search', await evalIn(ui.webContents, "!document.getElementById('tabSearchPanel').hidden && document.activeElement === document.getElementById('tabSearchInput')"));
  check('the tab list is shown in full below the bars', ui.getBounds().height >= 116 + 200, `toolbar view ${ui.getBounds().height}px`);
  await evalIn(ui.webContents, "(() => { const box = document.getElementById('tabSearchInput'); box.value = 'recip'; box.dispatchEvent(new Event('input')); })()");
  const found = await evalIn(ui.webContents, "[...document.querySelectorAll('#tabSearchList .ts-title')].map((row) => row.textContent)");
  check('typing finds open tabs by title, in tab order', JSON.stringify(found) === JSON.stringify(['Recipes everyone should know', 'Grandma recipes']), JSON.stringify(found));
  check('the match is marked', (await evalIn(ui.webContents, "document.querySelector('#tabSearchList mark')?.textContent")) === 'Recip');
  const press = (key, extra = '') => evalIn(ui.webContents, `document.getElementById('tabSearchInput').dispatchEvent(new KeyboardEvent('keydown', { key: '${key}', bubbles: true${extra} }))`);
  await press('ArrowDown');
  await press('Enter');
  await waitFor(() => tabs.activeId === made[1].id, 'chosen tab active', 3000).catch(() => {});
  check('arrow keys choose and Enter goes to the tab', tabs.activeId === made[1].id && (await evalIn(ui.webContents, "document.getElementById('tabSearchPanel').hidden")));
  await evalIn(ui.webContents, "document.getElementById('tabSearchButton').click()");
  await evalIn(ui.webContents, "(() => { const box = document.getElementById('tabSearchInput'); box.value = 'oslo'; box.dispatchEvent(new Event('input')); })()");
  await press('Delete', ', ctrlKey: true');
  await waitFor(() => !tabs.tabs.has(made[2].id), 'tab closed from the search', 3000).catch(() => {});
  check('Ctrl+Delete closes the chosen tab, and the list follows', !tabs.tabs.has(made[2].id) &&
    /No open tab matches/.test(await evalIn(ui.webContents, "new Promise((r) => setTimeout(() => r(document.getElementById('tabSearchList').textContent), 300))")));
  await press('Escape');
  check('Esc closes tab search', await evalIn(ui.webContents, "document.getElementById('tabSearchPanel').hidden"));

  // ---------- Clear browsing data ----------
  settings.update({ historyEnabled: true });
  const browse = tabs.active;
  await load(`${base}/page/Recent`, browse);
  await load(`${base}/cookies?n=recent`, browse);
  // An old visit and an old cookie, from before the range.
  const longAgo = Date.now() - 3 * 24 * 60 * 60 * 1000;
  history.entries.unshift({ id: 999, url: `${base}/page/Old`, title: 'Old', time: longAgo });
  await session.cookies.set({ url: `${otherBase}/`, name: 'ancient', value: '1', expirationDate: Date.now() / 1000 + 86400 });
  await waitFor(() => ctx.cookieClock.firstSeen({ domain: 'localhost', path: '/', name: 'ancient' }) > 0, 'cookie time kept');
  ctx.cookieClock.times.set('localhost\t/\tancient', longAgo);
  ctx.cookieClock.times.set('localhost\t/\tpref', longAgo);
  ctx.cookieClock.times.set('localhost\t/\tsid-other', longAgo);
  tabs.openInternal('settings');
  const page = tabs.active.view.webContents;
  await waitFor(() => tabs.active.title === 'Settings', 'settings page');
  await waitFor(async () => evalIn(page, "Boolean(document.getElementById('clearDataOpen'))"), 'clear button');
  await evalIn(page, "document.getElementById('clearDataOpen').click()");
  await waitFor(async () => /page/.test(await evalIn(page, "document.getElementById('clearHistoryNote').textContent")), 'summary shown');
  await evalIn(page, "(() => { const s = document.getElementById('clearRange'); s.value = 'hour'; s.dispatchEvent(new Event('change')); })()");
  await waitFor(async () => /from 1 site/.test(await evalIn(page, "document.getElementById('clearCookiesNote').textContent")), 'hour summary', 5000).catch(() => {});
  const summaryText = await evalIn(page, "[...document.querySelectorAll('.clear-kinds small')].map((n) => n.textContent).join(' | ')");
  check('the dialog says what the last hour holds', /2 pages in this time/.test(summaryText) && /2 cookies from 1 site/.test(summaryText) && /emptied whole/.test(summaryText), summaryText);
  await evalIn(page, "document.getElementById('clearConfirm').click()");
  await waitFor(async () => evalIn(page, "!document.getElementById('clearDataMessage').hidden"), 'cleared message');
  const message = await evalIn(page, "document.getElementById('clearDataMessage').textContent");
  check('clearing the last hour says what went', /^Cleared from the last hour: 2 pages of history, 2 cookies from 1 site, .+ of cache\.$/.test(message), message);
  check('history from the last hour is gone, older history stays', JSON.stringify(history.list().map((e) => e.title)) === '["Old"]', JSON.stringify(history.list().map((e) => e.title)));
  check('cookies set in the last hour are gone, older ones stay', JSON.stringify(await cookiesOf('127.0.0.1')) === '[]' && JSON.stringify(await cookiesOf('localhost')) === '["ancient","pref","sid-other"]',
    `${JSON.stringify(await cookiesOf('127.0.0.1'))} ${JSON.stringify(await cookiesOf('localhost'))}`);
  await evalIn(page, "document.getElementById('clearDataOpen').click()");
  await evalIn(page, "(() => { const s = document.getElementById('clearRange'); s.value = 'all'; s.dispatchEvent(new Event('change')); })()");
  await sleep(400);
  await evalIn(page, "document.getElementById('clearConfirm').click()");
  await waitFor(async () => /all time/.test(await evalIn(page, "document.getElementById('clearDataMessage').textContent")), 'all cleared');
  check('clearing all time empties history and every cookie', history.list().length === 0 && (await session.cookies.get({})).length === 0);
  check('bookmarks and settings are not touched', settings.data.historyEnabled === true);

  ctx.win.destroy();
  server.close();
  const ok = finish();
  app.exit(ok ? 0 : 1);
}

main().catch((error) => {
  console.error('SMOKE ERROR', error);
  app.exit(2);
});
