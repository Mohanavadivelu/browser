'use strict';

// Smoke test for restoring tabs on start-up and the home page setting.
// Run with: npm run smoke
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { app } = require('electron');
const { start } = require('../../src/main/app');
const { waitFor, createChecker, makeTempDir } = require('./helpers');

const { check, finish } = createChecker();

async function launch(userDataDir) {
  return start({ userDataDir, skipSingleInstanceLock: true, quitOnClose: false });
}

async function main() {
  // Several windows are opened and closed in turn; do not quit when one closes.
  app.on('window-all-closed', () => {});
  const work = makeTempDir();
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(`<!doctype html><title>Page ${req.url}</title>${req.url}`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = path.join(work, 'profile');
  fs.mkdirSync(profile, { recursive: true });

  // Closing the window before the toolbar has loaded must not throw in the main process
  // (checked by "no uncaught errors" at the end of the run).
  const early = await launch(path.join(work, 'early-profile'));
  early.win.destroy();
  await waitFor(() => early.ui.webContents.isDestroyed() || !early.ui.webContents.isLoading(), 'toolbar load settled', 5000)
    .catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 500));

  // A saved session is ignored unless the user turned restoring on.
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({
    restoreTabs: false,
    session: { urls: [`${base}/ignored`], active: 0 },
  }));
  const off = await launch(profile);
  check('tabs are not restored when the option is off', off.tabs.order.length === 1 && off.tabs.snapshot()[0].url === '');
  off.win.destroy();
  await waitFor(() => off.win.isDestroyed(), 'first window closed');

  // With the option on, the saved tabs come back and the right one is active.
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({
    restoreTabs: true,
    session: { urls: [`${base}/one`, `${base}/two`, 'file:///C:/Windows/win.ini'], active: 1 },
  }));
  const on = await launch(profile);
  await waitFor(() => on.tabs.snapshot().every((tab) => tab.url !== ''), 'restored pages loaded', 30000);
  const urls = on.tabs.snapshot().map((tab) => tab.url);
  check('saved tabs are restored (unsafe addresses dropped)', JSON.stringify(urls) === JSON.stringify([`${base}/one`, `${base}/two`]), urls.join(', '));
  check('the previously active tab is active again', on.tabs.snapshot().find((tab) => tab.id === on.tabs.activeId).url === `${base}/two`);

  // The session is saved on demand and excludes private and internal tabs.
  on.tabs.create({ url: `${base}/private`, isPrivate: true });
  on.tabs.openInternal('history');
  on.saveSession();
  const saved = JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8')).session;
  check('private and internal tabs are not saved in the session', saved.urls.length === 2 && saved.urls.every((u) => !u.includes('private')), saved.urls.join(', '));

  // Turning the option off removes the saved session from disk.
  on.settings.update({ restoreTabs: false });
  on.saveSession();
  const cleared = JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8')).session;
  check('turning restore off clears the saved session', cleared.urls.length === 0);
  on.win.destroy();
  await waitFor(() => on.win.isDestroyed(), 'second window closed');

  // Home page: used for the first tab at start-up.
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ homePage: `${base}/home` }));
  const home = await launch(profile);
  await waitFor(() => home.tabs.snapshot()[0]?.url === `${base}/home`, 'home page loaded');
  check('the home page opens at start-up', true);
  home.tabs.create();
  home.tabs.goHome();
  await waitFor(() => home.tabs.snapshot().some((tab, i) => i === 1 && tab.url === `${base}/home`), 'Home button loads the home page');
  check('the Home button opens the home page', true);

  server.close();
  const ok = finish();
  app.exit(ok ? 0 : 1);
}

main().catch((error) => {
  console.error('SMOKE ERROR', error);
  app.exit(2);
});
