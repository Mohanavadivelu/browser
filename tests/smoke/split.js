'use strict';

// Smoke test for split tabs (0.16.0): starting a split from the tab strip, from the shortcut and
// by dropping a tab on half of the page; the frame (headers, the bar, keys); resizing, swapping,
// a narrow window, the find bar, groups and moving, sleep, separating and closing; and a split
// coming back after a restart.
// Run with: npm run smoke -- split.js
const fs = require('node:fs');
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
  const work = makeTempDir('sb-split-');
  const profile = path.join(work, 'profile');
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ restoreTabs: true }));

  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    const title = decodeURIComponent(new URL(req.url, 'http://x').pathname.split('/').pop() || 'Page');
    res.end(`<!doctype html><title>${title}</title><body style="margin:0"><p>${title}</p><input id="box"></body>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const launch = () => start({ userDataDir: profile, skipSingleInstanceLock: true, blockerFilters: '', quitOnClose: false });
  const ctx = await launch();
  const { tabs, ui, host, actions } = ctx;
  const frame = host.splitView.webContents;
  await waitFor(() => ctx.win.isVisible() && !ui.webContents.isLoading() && !frame.isLoading(), 'window ready', 30000);
  ctx.win.setContentSize(1280, 800);
  const evalIn = (contents, code) => contents.executeJavaScript(code);
  const open = async (name, options = {}) => {
    const tab = tabs.create({ url: `${base}/page/${name}`, ...options });
    await waitFor(() => !tab.view.webContents.isLoading() && tab.title === name, `${name} loaded`);
    return tab;
  };
  const toolbarState = (code) => evalIn(ui.webContents, code);
  const toolbarKnows = (test) => waitFor(async () => Boolean(await toolbarState(`(() => { const s = state; return ${test}; })()`)), 'toolbar updated', 5000);
  const shown = (tab) => tab.view && host.contentViews.has(tab.view) && tab.view.getVisible();

  const alpha = await open('Alpha');
  const beta = await open('Beta', { activate: false });
  const gamma = await open('Gamma', { activate: false });
  tabs.close(tabs.order[0]); // the first new tab page
  tabs.activate(alpha.id);

  // ---------- Starting a split from the tab strip ----------
  await toolbarKnows(`s.tabs.length === 3 && s.activeId === ${alpha.id}`);
  const menu = await evalIn(ui.webContents, `(() => {
    const tab = state.tabs.find((t) => t.id === ${alpha.id});
    const items = splitItems(tab);
    const submenu = items.find((item) => item.label === 'Split with another tab')?.submenu() ?? [];
    return { labels: items.map((item) => item.label ?? '---'), choices: submenu.map((item) => item.label ?? '---') };
  })()`);
  check('a tab’s menu offers to split it with another tab, or a new one', menu.labels.includes('Split with another tab') &&
    JSON.stringify(menu.choices) === JSON.stringify(['Beta', 'Gamma', '---', 'New tab (Ctrl+Shift+L)']), JSON.stringify(menu));
  await evalIn(ui.webContents, `window.browserApi.tabs.split(${alpha.id}, ${beta.id}, 'right')`);
  const split = () => tabs.splitOf(alpha.id);
  await waitFor(() => split(), 'split made');
  check('the chosen tab is shown on the right, and is the side in use', split()?.left === alpha.id && split()?.right === beta.id && tabs.activeId === beta.id, JSON.stringify(split()));
  check('the two sides sit next to each other in the strip', tabs.order.indexOf(beta.id) === tabs.order.indexOf(alpha.id) + 1, JSON.stringify(tabs.order));
  const a = alpha.view.getBounds();
  const b = beta.view.getBounds();
  check('both pages are on screen, side by side, sharing the width', shown(alpha) && shown(beta) && !shown(gamma) && a.x < b.x && a.y === b.y && Math.abs(a.width - b.width) <= 1 && b.x + b.width <= 1280,
    `${JSON.stringify(a)} ${JSON.stringify(b)}`);
  await waitFor(async () => (await evalIn(frame, "document.querySelectorAll('.head').length")) === 2, 'frame drawn', 5000).catch(() => {});
  const heads = await evalIn(frame, "[...document.querySelectorAll('.head')].map((h) => h.dataset.side + ':' + h.className + ':' + h.textContent)");
  check('the frame shows a header for each side, the one in use marked', heads.length === 2 && /^left:head:127\.0\.0\.1/.test(heads[0]) && /^right:head on:127\.0\.0\.1.*Beta/.test(heads[1]), JSON.stringify(heads));
  check('the frame lies behind the pages, in the space around them', host.splitView.getVisible() && host.splitPlace === 'bottom' && host.splitView.getBounds().y === a.y - 34);
  await toolbarKnows(`document.querySelector('.split-pair') && !document.getElementById('splitSide').hidden`);
  const strip = await toolbarState("(() => { const p = document.querySelector('.split-pair'); return { members: [...p.querySelectorAll('.tab')].map((t) => t.textContent), active: p.querySelector('.tab.active')?.textContent, tag: document.getElementById('splitSide').textContent }; })()");
  check('the strip shows the two in one place, the side in use highlighted', JSON.stringify(strip.members) === '["Alpha","Beta"]' && strip.active === 'Beta', JSON.stringify(strip));
  check('the address bar says which side is in use', strip.tag === 'Right side', strip.tag);

  // ---------- The side in use ----------
  await evalIn(frame, "document.querySelector('.head[data-side=\"left\"]').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))");
  await waitFor(() => tabs.activeId === alpha.id, 'left in use', 5000).catch(() => {});
  check('clicking a side’s header makes it the side in use', tabs.activeId === alpha.id && split().focused === 'left' && shown(beta));
  beta.view.webContents.focus();
  await waitFor(() => tabs.activeId === beta.id, 'right in use by focus', 5000).catch(() => {});
  check('so does clicking into its page', tabs.activeId === beta.id && split().focused === 'right');
  await evalIn(ui.webContents, "document.getElementById('splitSide').click()");
  await waitFor(() => tabs.activeId === alpha.id, 'side tag', 5000).catch(() => {});
  check('the address bar’s tag switches to the other side', tabs.activeId === alpha.id);

  // ---------- Resizing ----------
  await evalIn(frame, 'window.browserApi.split.ratio(0.6)');
  await waitFor(() => split().ratio === 0.6, 'ratio set', 5000).catch(() => {});
  check('the bar sets the left side’s share of the width', split().ratio === 0.6 && alpha.view.getBounds().width > beta.view.getBounds().width * 1.4,
    `${alpha.view.getBounds().width} ${beta.view.getBounds().width}`);
  await evalIn(frame, 'window.browserApi.split.ratio(0.66)');
  await waitFor(() => split().ratio !== 0.6, 'snapped', 5000).catch(() => {});
  check('near two thirds it snaps there', Math.abs(split().ratio - 2 / 3) < 1e-9, String(split().ratio));
  await evalIn(frame, 'window.browserApi.split.ratio(0.95)');
  await waitFor(() => split().ratio === 0.75, 'clamped', 5000).catch(() => {});
  check('a side keeps at least a quarter', split().ratio === 0.75);
  await evalIn(frame, "document.getElementById('divider').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))");
  await waitFor(() => split().ratio === 0.7, 'key', 5000).catch(() => {});
  check('the arrow keys move the bar', split().ratio === 0.7, String(split().ratio));
  await evalIn(frame, "document.getElementById('divider').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))");
  await waitFor(() => split().ratio === 0.5, 'even', 5000).catch(() => {});
  check('double-clicking the bar evens the widths', split().ratio === 0.5);
  await evalIn(frame, "document.getElementById('divider').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 640 }))");
  await waitFor(() => host.splitPlace === 'top', 'frame in front', 5000).catch(() => {});
  check('while the bar is dragged the frame comes in front of the pages', host.splitPlace === 'top' && await evalIn(frame, "document.body.classList.contains('dragging')"));
  await evalIn(frame, "document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 420 }))");
  await waitFor(() => split().ratio < 0.4, 'dragged', 5000).catch(() => {});
  const dragged = split().ratio;
  const readout = await evalIn(frame, "document.querySelector('.readout')?.textContent ?? ''");
  await evalIn(frame, "document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 420 }))");
  await waitFor(() => host.splitPlace === 'bottom', 'frame behind', 5000).catch(() => {});
  check('dragging the bar resizes the sides, showing the split as it goes', dragged > 0.3 && dragged < 0.4 && /^\d+ : \d+$/.test(readout), `${dragged} ${readout}`);
  check('...and the frame goes back behind the pages after', host.splitPlace === 'bottom');
  tabs.setSplitRatio(alpha.id, 0.5);

  // ---------- Swapping, the find bar, a narrow window ----------
  tabs.swapSplit(alpha.id);
  check('Swap sides puts each page on the other side', split().left === beta.id && split().right === alpha.id && beta.view.getBounds().x < alpha.view.getBounds().x &&
    tabs.order.indexOf(alpha.id) === tabs.order.indexOf(beta.id) + 1);
  check('...and the same page stays in use', tabs.activeId === alpha.id && split().focused === 'right');
  actions.find();
  await waitFor(() => host.find.getVisible(), 'find bar', 5000).catch(() => {});
  const findBox = host.find.getBounds();
  const inUse = alpha.view.getBounds();
  check('the find bar opens over the side in use', findBox.x >= inUse.x && findBox.x + findBox.width <= inUse.x + inUse.width, `${JSON.stringify(findBox)} ${JSON.stringify(inUse)}`);
  host.closeFind();
  ctx.win.setContentSize(700, 700);
  await waitFor(() => !shown(beta), 'narrow', 5000).catch(() => {});
  const picks = await evalIn(frame, "[...document.querySelectorAll('.pick')].map((p) => p.dataset.side + ':' + p.getAttribute('aria-pressed'))");
  check('in a narrow window only the side in use is shown, with a switch to the other', shown(alpha) && !shown(beta) && alpha.view.getBounds().width === 700 - 12 &&
    JSON.stringify(picks) === '["left:false","right:true"]', JSON.stringify(picks));
  await evalIn(frame, "document.querySelector('.pick[data-side=\"left\"]').click()");
  await waitFor(() => tabs.activeId === beta.id && shown(beta) && !shown(alpha), 'switched', 5000).catch(() => {});
  check('the switch shows the other side', tabs.activeId === beta.id && shown(beta) && !shown(alpha));
  ctx.win.setContentSize(1280, 800);
  await waitFor(() => shown(alpha) && shown(beta), 'wide again', 5000).catch(() => {});
  check('wide again, both sides are back', shown(alpha) && shown(beta));

  // ---------- A page's own full screen ----------
  host.setHtmlFullscreen(true, alpha.view);
  await waitFor(() => !shown(beta) && alpha.view.getBounds().y === 0, 'side full screen', 8000).catch(() => {});
  check('a video full screen on one side fills the window', !shown(beta) && alpha.view.getBounds().y === 0 && !host.splitView.getVisible());
  host.setHtmlFullscreen(false, alpha.view);
  await waitFor(() => shown(beta) && host.splitView.getVisible(), 'split again', 8000).catch(() => {});
  check('...and the split comes back after', shown(alpha) && shown(beta));

  // ---------- Groups, moving, sleep, pinning ----------
  const group = tabs.newGroup(alpha.id);
  check('a split joins a group as one', tabs.tabs.get(alpha.id).groupId === group && tabs.tabs.get(beta.id).groupId === group);
  tabs.move(beta.id, 99);
  check('a split moves as one', tabs.order.at(-1) === alpha.id && tabs.order.at(-2) === beta.id, JSON.stringify(tabs.order));
  tabs.removeFromGroup(alpha.id);
  check('...and leaves its group as one', !tabs.tabs.get(alpha.id).groupId && !tabs.tabs.get(beta.id).groupId);
  check('neither side of the split on screen can be put to sleep', !(await tabs.canSleep(beta.id)) && !(await tabs.canSleep(alpha.id)));
  check('a tab of a split can’t be pinned', tabs.pin(beta.id, true) === false);
  const privateTab = await open('Private', { isPrivate: true, activate: false });
  check('a private tab isn’t split with a regular one', tabs.split(gamma.id, privateTab.id) === null && !tabs.tabs.get(gamma.id).splitId);
  tabs.close(privateTab.id);

  // ---------- Separating and closing ----------
  await evalIn(ui.webContents, `window.browserApi.tabs.unsplit(${beta.id})`);
  await waitFor(() => !split(), 'separated', 5000).catch(() => {});
  check('Open in its own tab separates them, showing that side alone', !split() && tabs.activeId === beta.id && shown(beta) && !shown(alpha) &&
    beta.view.getBounds().x === 0 && !host.splitView.getVisible());
  actions.splitWithNewTab();
  const made = tabs.splitOf(beta.id);
  check('Ctrl+Shift+L opens a new tab beside the one in use', made && made.left === beta.id && tabs.activeId === made.right && tabs.tabs.size === 4);
  const fresh = tabs.tabs.get(made.right);
  await waitFor(() => /newtab\.html/.test(fresh.view.webContents.getURL()), 'new tab page');
  tabs.close(fresh.id);
  check('closing one side leaves the other as a tab of its own, in use', !tabs.splitOf(beta.id) && tabs.activeId === beta.id && shown(beta) && beta.view.getBounds().x === 0);

  // ---------- Dropping a tab on half of the page ----------
  tabs.activate(gamma.id);
  await toolbarKnows(`s.activeId === ${gamma.id}`);
  await evalIn(ui.webContents, `(() => {
    const node = document.querySelector('#tabs .tab[data-id="${alpha.id}"]');
    node.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: new DataTransfer() }));
  })()`);
  await waitFor(async () => evalIn(ui.webContents, "!document.getElementById('splitDrop').hidden"), 'drop halves', 5000).catch(() => {});
  const halves = await evalIn(ui.webContents, "(() => { const box = document.getElementById('splitDrop'); return { shown: !box.hidden, text: box.textContent.trim(), height: box.offsetHeight }; })()");
  check('dragging a tab shows two halves of the page to drop it on', halves.shown && /Show “Alpha” on the left/.test(halves.text) && halves.height > 400 && ui.getBounds().height > 600,
    `${JSON.stringify(halves)} ${ui.getBounds().height}`);
  await evalIn(ui.webContents, `(() => {
    const half = document.querySelector('.split-drop-half[data-side="left"]');
    const data = new DataTransfer();
    data.setData('application/x-simple-browser-tab', '${alpha.id}');
    half.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }));
    half.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
  })()`);
  await waitFor(() => tabs.splitOf(gamma.id), 'dropped', 5000).catch(() => {});
  const droppedSplit = tabs.splitOf(gamma.id);
  check('dropped on the left half, the tab is shown there beside the page', droppedSplit?.left === alpha.id && droppedSplit?.right === gamma.id && tabs.activeId === alpha.id,
    JSON.stringify(droppedSplit));
  await waitFor(async () => evalIn(ui.webContents, "document.getElementById('splitDrop').hidden"), 'halves gone', 5000).catch(() => {});
  check('...and the halves go away', await evalIn(ui.webContents, "document.getElementById('splitDrop').hidden") && ui.getBounds().height < 200, String(ui.getBounds().height));
  tabs.setSplitRatio(alpha.id, 0.4);

  // ---------- Web pages ----------
  check('pages in a split still have no bridge to the browser', (await evalIn(alpha.view.webContents, 'typeof window.browserApi')) === 'undefined');
  const refused = await evalIn(ui.webContents, "window.browserApi.split.ratio(0.3).then(() => 'ran', (e) => String(e))");
  check('the toolbar can’t move the bar (only the split’s own frame can)', /Rejected IPC "split:ratio" from the toolbar page/.test(refused), refused);

  // ---------- After a restart ----------
  ctx.saveSession();
  ctx.win.close();
  await waitFor(() => ctx.win.isDestroyed(), 'first window closed');
  const again = await launch();
  await waitFor(() => again.win.isVisible() && again.tabs.order.length >= 3, 'restarted', 30000);
  await sleep(500);
  const back = [...again.tabs.splits.values()];
  const titles = (id) => again.tabs.snapshot().find((tab) => tab.id === id)?.url.split('/').pop();
  check('after a restart the split comes back, with its widths and the side in use', back.length === 1 && titles(back[0].left) === 'Alpha' && titles(back[0].right) === 'Gamma' &&
    back[0].ratio === 0.4 && again.tabs.activeId === back[0].left, JSON.stringify(back));
  const closeBoth = again.tabs.closeSplit(back[0].left);
  check('closing the split closes both sides', closeBoth === 2 && again.tabs.splits.size === 0 && !again.tabs.snapshot().some((tab) => ['Alpha', 'Gamma'].includes(tab.title)));

  again.win.destroy();
  server.close();
  const ok = finish();
  app.exit(ok ? 0 : 1);
}

main().catch((error) => {
  console.error('SMOKE ERROR', error);
  app.exit(2);
});
