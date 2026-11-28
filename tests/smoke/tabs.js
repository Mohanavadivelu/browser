'use strict';

// Smoke test for 0.14.0: pinned tabs, tab groups, sleeping tabs (and the memory saver), the
// full-page screenshot, and reading mode; and that pinned tabs and groups come back after a
// restart. Run with: npm run smoke -- tabs.js
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { app } = require('electron');
const { start, prepare } = require('../../src/main/app');
const { sleep, waitFor, createChecker, makeTempDir } = require('./helpers');

prepare();

const PARAGRAPH = 'The river town wakes slowly. Boats knock against the pier while the first ferry warms its engine, and the bakery on the corner sets out the morning bread. ';
const PAGES = {
  '/article': `<!doctype html><title>River town</title><body><nav>Home · News · Sport · Weather</nav><div class="ad">Buy now!</div>
    <article><h1>A morning in the river town</h1><p class="byline">By Ana Ferreira</p>${Array.from({ length: 12 }, (_, i) => `<p>${PARAGRAPH.repeat(3)} (${i + 1})</p>`).join('')}</article>
    <script>window.pageSecret = 'page';</script><footer>About · Contact</footer></body>`,
  '/long': '<!doctype html><title>Long</title><body style="margin:0"><div style="height:5000px;background:linear-gradient(#e00,#00e)">top</div>bottom</body>',
  '/scroll': '<!doctype html><title>Scroll</title><body style="margin:0"><div style="height:8000px">tall</div></body>',
  '/form': '<!doctype html><title>Form</title><body><input id="q" name="q"><textarea id="t"></textarea></body>',
};

async function main() {
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  app.on('window-all-closed', () => {});
  const { check, finish } = createChecker();
  const work = makeTempDir('sb-tabs-');
  const profile = path.join(work, 'profile');
  const recordings = path.join(work, 'recordings');
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ restoreTabs: true, recordingFolder: recordings }));

  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    const url = new URL(req.url, 'http://x');
    const title = decodeURIComponent(url.pathname.split('/').pop() || 'Page');
    res.end(PAGES[url.pathname] ?? `<!doctype html><title>${title}</title><p>${title}</p>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const launch = () => start({ userDataDir: profile, skipSingleInstanceLock: true, blockerFilters: '', quitOnClose: false });
  const ctx = await launch();
  const { tabs, ui, settings, actions } = ctx;
  await waitFor(() => ctx.win.isVisible() && !ui.webContents.isLoading(), 'window ready', 30000);
  const evalIn = (contents, code) => contents.executeJavaScript(code);
  const snap = (id) => tabs.snapshot().find((tab) => tab.id === id);
  const load = async (tab, url) => {
    tab.view.webContents.loadURL(url).catch(() => {});
    await waitFor(() => tab.view?.webContents.getURL() === url && !tab.view.webContents.isLoading(), `load ${url}`);
  };
  const order = () => tabs.order.join(',');

  // ---------- Pinned tabs ----------
  const mail = tabs.active;
  await load(mail, `${base}/page/Mail`);
  const calendar = tabs.create({ url: `${base}/page/Calendar`, activate: false });
  const other = tabs.create({ url: `${base}/page/Other` });
  await waitFor(() => !calendar.view.webContents.isLoading() && !other.view.webContents.isLoading(), 'tabs loaded');
  await evalIn(ui.webContents, `window.browserApi.tabs.pin(${calendar.id}, true)`);
  check('a pinned tab moves to the start of the strip', tabs.order[0] === calendar.id && snap(calendar.id).pinned, order());
  await evalIn(ui.webContents, `window.browserApi.tabs.pin(${mail.id}, true)`);
  check('pinned tabs stay together, in the order they were pinned', tabs.order.slice(0, 2).join(',') === `${calendar.id},${mail.id}`, order());
  tabs.move(other.id, 0);
  check('an unpinned tab can’t be dragged in among the pinned ones', tabs.order[2] === other.id, order());
  await waitFor(async () => evalIn(ui.webContents, "document.querySelectorAll('#tabs .tab.pinned').length === 2"), 'pinned drawn');
  check('pinned tabs are drawn small, without a close button', await evalIn(ui.webContents, "[...document.querySelectorAll('#tabs .tab.pinned')].every((tab) => !tab.querySelector('.close') && !tab.querySelector('.title'))"));
  tabs.activate(mail.id);
  ctx.win.focus();
  mail.view.webContents.focus();
  mail.view.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'W', modifiers: ['control'] });
  await sleep(500);
  check('Ctrl+W doesn’t close a pinned tab', tabs.tabs.has(mail.id));
  await waitFor(() => settings.data.pinnedTabs.length === 2, 'pinned tabs saved', 5000).catch(() => {});
  check('pinned tabs are kept for the next start', JSON.stringify(settings.data.pinnedTabs) === JSON.stringify([`${base}/page/Calendar`, `${base}/page/Mail`]), JSON.stringify(settings.data.pinnedTabs));

  // ---------- Tab groups ----------
  const [a, b, c] = ['Flights', 'Hotel', 'Museum'].map((name) => tabs.create({ url: `${base}/page/${name}`, activate: false }));
  await waitFor(() => [a, b, c].every((tab) => !tab.view.webContents.isLoading()), 'group tabs loaded');
  const group = await evalIn(ui.webContents, `window.browserApi.tabs.newGroup(${a.id})`);
  await evalIn(ui.webContents, `window.browserApi.tabs.addToGroup(${c.id}, '${group}')`);
  const at = (id) => tabs.order.indexOf(id);
  check('a group’s tabs sit together', snap(a.id).groupId === group && snap(c.id).groupId === group && at(c.id) === at(a.id) + 1 && !snap(b.id).groupId, order());
  tabs.move(b.id, at(c.id));
  check('a tab dropped between two of a group’s tabs joins it', snap(b.id).groupId === group, order());
  tabs.move(c.id, tabs.order.indexOf(other.id)); // dragged out, in front of a tab outside the group
  check('a tab dragged away from its group leaves it', !snap(c.id).groupId && snap(a.id).groupId === group, order());
  await evalIn(ui.webContents, `window.browserApi.tabs.updateGroup('${group}', { name: 'Trip', color: 'green' })`);
  await waitFor(async () => (await evalIn(ui.webContents, "document.querySelector('#tabs .group-chip')?.textContent")) === 'Trip', 'chip drawn');
  check('the group shows as a named, coloured chip before its tabs', await evalIn(ui.webContents, "(() => { const chip = document.querySelector('#tabs .group-chip'); return chip.classList.contains('group-green') && chip.nextElementSibling.classList.contains('grouped'); })()"));
  tabs.activate(b.id);
  await evalIn(ui.webContents, "document.querySelector('#tabs .group-chip').click()");
  await waitFor(() => tabs.groups.get(group).collapsed, 'folded away');
  await waitFor(async () => evalIn(ui.webContents, `!document.querySelector('#tabs .tab[data-id="${a.id}"]')`), 'strip redrawn', 3000).catch(() => {});
  check('folding a group away hides its tabs, and the tab shown moves out of it', tabs.activeId !== a.id && tabs.activeId !== b.id &&
    await evalIn(ui.webContents, `!document.querySelector('#tabs .tab[data-id="${a.id}"]') && /2/.test(document.querySelector('#tabs .group-chip').textContent)`));
  tabs.activate(a.id);
  check('opening a tab of a folded group unfolds it', !tabs.groups.get(group).collapsed);
  const saved = tabs.sessionSnapshot();
  check('groups are part of the saved session', saved.groups.length === 1 && saved.groups[0].name === 'Trip' && saved.groups[0].tabs.length === 2, JSON.stringify(saved.groups));

  // ---------- Sleeping tabs ----------
  const reading = tabs.create({ url: `${base}/page/First` });
  await waitFor(() => !reading.view.webContents.isLoading(), 'first page');
  await load(reading, `${base}/scroll`);
  await evalIn(reading.view.webContents, 'window.scrollTo(0, 3000), true');
  await sleep(300);
  const typed = tabs.create({ url: `${base}/form` });
  await waitFor(() => !typed.view.webContents.isLoading(), 'form page');
  await evalIn(typed.view.webContents, "document.getElementById('q').value = 'half-written', true");
  tabs.activate(other.id);
  check('a page with something typed in isn’t put to sleep', (await tabs.canSleep(typed.id)) === false);
  check('a pinned tab isn’t put to sleep', (await tabs.canSleep(mail.id)) === false);
  check('the tab shown isn’t put to sleep', (await tabs.canSleep(other.id)) === false);
  const oldContents = reading.view.webContents;
  const slept = await evalIn(ui.webContents, `window.browserApi.tabs.sleep(${reading.id})`);
  await sleep(300);
  check('a background tab can be put to sleep: its page is closed', slept === true && reading.view === null && oldContents.isDestroyed() && snap(reading.id).sleeping);
  check('a sleeping tab keeps its title and address', snap(reading.id).title === 'Scroll' && snap(reading.id).url === `${base}/scroll` && snap(reading.id).canGoBack);
  await waitFor(async () => evalIn(ui.webContents, `document.querySelector('#tabs .tab[data-id="${reading.id}"]')?.classList.contains('sleeping')`), 'sleeping drawn');
  check('a sleeping tab is drawn dimmed', true);
  tabs.activate(reading.id);
  await waitFor(() => reading.view && !reading.view.webContents.isLoading() && reading.view.webContents.getURL() === `${base}/scroll`, 'woke', 10000);
  await sleep(400);
  const scrolled = await evalIn(reading.view.webContents, 'window.scrollY');
  check('opening it wakes it where it was, scroll position and all', !snap(reading.id).sleeping && scrolled > 2500, `scrollY ${scrolled}`);
  check('...with its history', reading.view.webContents.navigationHistory.canGoBack());

  settings.update({ memorySaverMinutes: 15 });
  c.inactiveSince = Date.now() - 20 * 60 * 1000;
  const asleep = await ctx.memorySaver.check();
  check('the memory saver puts tabs in the background longer than the setting to sleep', asleep >= 1 && snap(c.id).sleeping, `${asleep} put to sleep`);

  // ---------- Full-page screenshot ----------
  const long = tabs.active;
  await load(long, `${base}/long`);
  await sleep(300);
  const png = await actions.fullScreenshot();
  const header = png ? fs.readFileSync(png) : Buffer.alloc(0);
  const height = header.length > 24 ? header.readUInt32BE(20) : 0;
  check('the full-page screenshot holds the whole page', height >= 5000, `${height}px tall`);
  const visible = await actions.screenshot();
  const visibleHeight = visible ? fs.readFileSync(visible).readUInt32BE(20) : 0;
  check('...while the ordinary screenshot holds only what is shown', visibleHeight > 0 && visibleHeight < height, `${visibleHeight}px`);

  // ---------- Reading mode ----------
  await load(long, `${base}/article`);
  await waitFor(() => snap(long.id).readerable, 'article found', 8000).catch(() => {});
  check('a page with an article offers reading mode', snap(long.id).readerable && await evalIn(ui.webContents, "!document.getElementById('reader').hidden"));
  await evalIn(ui.webContents, "document.getElementById('reader').click()");
  await waitFor(async () => evalIn(long.view.webContents, "Boolean(document.querySelector('simple-browser-reader'))"), 'reading mode open', 5000).catch(() => {});
  check('reading mode shows the article over the page', await evalIn(long.view.webContents, "Boolean(document.querySelector('simple-browser-reader'))"));
  check('...in a closed shadow root the page’s scripts can’t reach', (await evalIn(long.view.webContents, "document.querySelector('simple-browser-reader').shadowRoot")) === null);
  await evalIn(ui.webContents, "document.getElementById('reader').click()");
  await waitFor(async () => !(await evalIn(long.view.webContents, "Boolean(document.querySelector('simple-browser-reader'))")), 'reading mode closed', 5000).catch(() => {});
  check('the button closes it again', !(await evalIn(long.view.webContents, "Boolean(document.querySelector('simple-browser-reader'))")));
  await load(long, `${base}/page/Short`);
  await sleep(1200);
  check('a page without an article doesn’t offer it', !snap(long.id).readerable);

  // ---------- After a restart ----------
  ctx.win.close();
  await waitFor(() => ctx.win.isDestroyed(), 'first window closed');
  const again = await launch();
  await waitFor(() => again.win.isVisible() && again.tabs.order.length >= 4, 'restarted', 30000);
  const first = again.tabs.snapshot();
  check('after a restart the pinned tabs come first', first[0].pinned && first[1].pinned && first[0].url === `${base}/page/Calendar` && first[1].url === `${base}/page/Mail`,
    JSON.stringify(first.slice(0, 2).map((tab) => [tab.url, tab.pinned])));
  check('...not twice', first.filter((tab) => tab.pinned).length === 2 && first.filter((tab) => tab.url === `${base}/page/Mail`).length === 1);
  const groups = again.tabs.groupsSnapshot();
  check('...and the tab group comes back, with its name, colour and tabs', groups.length === 1 && groups[0].name === 'Trip' && groups[0].color === 'green' && groups[0].count === 2,
    JSON.stringify(groups));

  again.win.destroy();
  server.close();
  const ok = finish();
  app.exit(ok ? 0 : 1);
}

main().catch((error) => {
  console.error('SMOKE ERROR', error);
  app.exit(2);
});
