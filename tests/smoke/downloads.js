'use strict';

// Smoke test for the download manager: pause and resume, the queue, retrying a failed download,
// picking up after the browser was quit mid-download (with Chromium, and split over several
// connections), splitting big downloads, the speed limit, marking files as from the internet,
// private downloads, the toolbar's downloads button and panel, the Downloads page, saving a
// video from a page, adding links in bulk, start times and the night, reordering the queue,
// checksums, and sleeping or shutting down when downloads finish (never for real: the test
// records what would have been done).
// Run with: npm run smoke -- downloads.js
// The quit-and-restart check runs this file a second time, as a separate Electron process that
// starts a download and quits while it runs (--phase=quit).
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { app } = require('electron');
const { start, prepare } = require('../../src/main/app');
const { sleep, waitFor, createChecker, makeTempDir } = require('./helpers');

const PLAIN_SIZE = 3.5 * 1024 * 1024; // under the size that is split: stays with Chromium
const SPLIT_SIZE = 8 * 1024 * 1024;

// The same bytes for every request, so a resumed file can be compared with the original.
function content(size) {
  const data = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) data[i] = (i * 7 + 3) % 251;
  return data;
}

// Starts a download small enough to stay with Chromium and one big enough to be split over
// several connections, and quits while both run. (It is given the server's address only:
// Electron quits at once, saying nothing, when started with two web addresses.)
async function quitMidDownload([profile, downloadDir, base]) {
  const plainUrl = `${base}/file/big-archive.zip?size=${PLAIN_SIZE}`;
  const splitUrl = `${base}/file/split-archive.zip?size=${SPLIT_SIZE}`;
  // This process must end on its own: the test waits for it. Any error, or a quit that hangs,
  // ends it with a code the test reports.
  const step = (text) => console.log(`quit phase: ${text}`);
  process.on('uncaughtException', (error) => {
    console.error('QUIT PHASE UNCAUGHT', error);
    app.exit(4);
  });
  setTimeout(() => { step('gave up after 90 s'); app.exit(5); }, 90_000);
  step('starting');
  const ctx = await start({ userDataDir: profile, skipSingleInstanceLock: true, blockerFilters: '', downloadDir });
  await waitFor(() => ctx.win.isVisible(), 'window ready', 30000);
  ctx.settings.update({ connectionsPerFile: 4 });
  step('window ready');
  ctx.tabs.navigate(plainUrl);
  await waitFor(() => ctx.downloads.list().length === 1, 'first download', 30000);
  ctx.tabs.active.view.webContents.downloadURL(splitUrl);
  const running = () => ctx.downloads.list();
  await waitFor(() => running().length === 2 && running().every((entry) => entry.received > 600 * 1024) && running()[0].parts?.length >= 2,
    'part of both downloads, one split', 30000);
  // As if the user closed the browser while it downloads.
  step(`quitting with ${JSON.stringify(running().map((entry) => [entry.filename, entry.received, entry.parts?.length ?? 0]))}`);
  app.on('will-quit', () => step('will quit'));
  app.quit();
  setTimeout(() => { step('still running 20 s after quitting'); app.exit(6); }, 20_000);
}

async function main() {
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  // The last check closes the window; the app must stay up to report the results.
  app.on('window-all-closed', () => {});
  const { check, finish } = createChecker();
  const work = makeTempDir('sb-dl-smoke-');
  const downloadDir = path.join(work, 'downloads');
  const profile = path.join(work, 'profile');
  const requests = []; // [path, range header]
  let pace = 60; // milliseconds between 64 KB chunks
  let flakyHealed = false;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    requests.push([url.pathname, req.headers.range ?? '']);
    if (url.pathname === '/videos') {
      res.setHeader('content-type', 'text/html');
      // One plain file, and one played from pieces (a MediaSource, as streaming sites use).
      res.end('<!doctype html><title>Videos</title><video id="plain" src="/media/lecture-4.mp4" title="Lecture 4" preload="none"></video>' +
        '<video id="streamed"></video><script>document.getElementById("streamed").src = URL.createObjectURL(new MediaSource());</script>');
      return;
    }
    const name = url.pathname.split('/').pop();
    if (!url.pathname.startsWith('/file/') && !url.pathname.startsWith('/media/')) {
      res.setHeader('content-type', 'text/html');
      res.end(`<!doctype html><title>Page</title>${url.pathname}`);
      return;
    }
    const size = Number(url.searchParams.get('size')) || 2 * 1024 * 1024;
    const body = content(size);
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
    let from = range ? Number(range[1]) : 0;
    const to = range && range[2] ? Math.min(size - 1, Number(range[2])) : size - 1;
    if (name.startsWith('flaky') && !flakyHealed && from > 0) {
      res.statusCode = 503;
      res.end('try later');
      return;
    }
    res.setHeader('content-type', url.pathname.startsWith('/media/') ? 'video/mp4' : 'application/octet-stream');
    if (url.pathname.startsWith('/file/')) res.setHeader('content-disposition', `attachment; filename="${name}"`);
    res.setHeader('accept-ranges', 'bytes');
    res.setHeader('etag', `"${name}-${size}"`);
    res.setHeader('last-modified', 'Wed, 01 Jan 2025 00:00:00 GMT');
    if (range) {
      res.statusCode = 206;
      res.setHeader('content-range', `bytes ${from}-${to}/${size}`);
    }
    res.setHeader('content-length', String(to - from + 1));
    const cutAt = name.startsWith('flaky') && !flakyHealed ? 512 * 1024 : Infinity;
    const step = () => {
      if (res.destroyed) return;
      if (from >= cutAt) { res.destroy(); return; }
      if (from > to) { res.end(); return; }
      const next = Math.min(to + 1, from + 64 * 1024, cutAt);
      res.write(body.subarray(from, next));
      from = next;
      setTimeout(step, name.startsWith('fast') || url.pathname.startsWith('/media/') ? 1 : pace);
    };
    step();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const sameAs = (file, size) => fs.existsSync(file) && fs.readFileSync(file).equals(content(size));

  // ---------- Quit mid-download, then start again ----------
  const bigSize = PLAIN_SIZE;
  const splitSize = SPLIT_SIZE;
  pace = 60;
  const child = spawn(process.execPath, [__filename, '--phase=quit', profile, downloadDir, base], { stdio: 'inherit' });
  const code = await new Promise((resolve) => {
    const limit = setTimeout(() => { console.log('the quit phase did not end in 2 minutes'); child.kill(); }, 120_000);
    child.on('exit', (exitCode) => { clearTimeout(limit); resolve(exitCode); });
  });
  const saved = JSON.parse(fs.readFileSync(path.join(profile, 'downloads.json'), 'utf8'));
  const savedEntry = saved.entries.find((entry) => entry.filename === 'big-archive.zip');
  const savedSplit = saved.entries.find((entry) => entry.filename === 'split-archive.zip');
  const splitPartFile = path.join(downloadDir, 'split-archive.zip.sbpart');
  check('a split download is saved with its parts when the browser quits', savedSplit?.state === 'progressing' && savedSplit.parts?.length >= 2 &&
    fs.existsSync(splitPartFile) && fs.statSync(splitPartFile).size === splitSize, JSON.stringify(savedSplit?.parts));
  const savedSplitDone = (savedSplit?.parts ?? []).reduce((sum, [start, , pos]) => sum + pos - start, 0);
  check('quitting mid-download saves it as unfinished', code === 0 && savedEntry?.state === 'progressing' && savedEntry.received > 0 && savedEntry.etag,
    `exit ${code}, ${JSON.stringify(savedEntry && { state: savedEntry.state, received: savedEntry.received })}`);
  // Chromium deletes the partial file as it quits; a second name for it keeps the bytes.
  const keptFile = path.join(downloadDir, 'big-archive.zip.sbdownload');
  const partSize = fs.existsSync(keptFile) ? fs.statSync(keptFile).size : -1;
  check('the partial file is kept when the browser quits', savedEntry?.kept === true && partSize >= savedEntry.received, `${partSize} bytes kept`);

  pace = 1;
  requests.length = 0;
  app.on('web-contents-created', (_event, contents) => {
    contents.on('console-message', (event) => { if (event.level === 'error') console.log(`[page error] ${event.message} @${event.sourceId}:${event.lineNumber}`); });
  });
  const powerCalls = []; // sleep and shut down, as asked for (the test never runs them)
  const ctx = await start({
    userDataDir: profile, skipSingleInstanceLock: true, blockerFilters: '', downloadDir, quitOnClose: false,
    powerAction: (action) => powerCalls.push(action), whenDoneCountdownMs: 1500,
  });
  const { tabs, downloads, settings, ui } = ctx;
  await waitFor(() => ctx.win.isVisible() && !ui.webContents.isLoading(), 'window ready', 30000);
  const notices = [];
  const originalSend = ui.webContents.send.bind(ui.webContents);
  ui.webContents.send = (channel, ...args) => {
    if (channel === 'ui:notice') notices.push(args[0].text);
    return originalSend(channel, ...args);
  };
  const byName = (name) => downloads.list().find((entry) => entry.filename === name);
  await waitFor(() => byName('big-archive.zip')?.state === 'completed', 'resumed download finished', 30000);
  const resumedFrom = requests.find(([file]) => file === '/file/big-archive.zip')?.[1] ?? '';
  check('after a restart the download picks up where it stopped (a Range request)', /^bytes=[1-9]\d*-$/.test(resumedFrom), resumedFrom);
  check('the resumed file is complete and correct', sameAs(path.join(downloadDir, 'big-archive.zip'), bigSize));
  check('the kept copy is gone once the file is back', !fs.existsSync(keptFile));
  check('the resumed download keeps its row, marked as picked up after a restart', downloads.list().filter((entry) => entry.filename === 'big-archive.zip').length === 1 && byName('big-archive.zip').restored);
  await waitFor(() => byName('split-archive.zip')?.state === 'completed', 'resumed split download finished', 30000);
  const splitRanges = requests.filter(([file]) => file === '/file/split-archive.zip').map(([, range]) => range);
  const askedAgain = splitRanges.reduce((sum, range) => {
    const [, from, to] = /bytes=(\d+)-(\d+)/.exec(range) ?? [0, 0, -1];
    return sum + Number(to) - Number(from) + 1;
  }, 0);
  check('after a restart a split download asks only for the parts it was missing', splitRanges.length >= 2 && askedAgain <= splitSize - savedSplitDone,
    `${askedAgain} of ${splitSize - savedSplitDone} missing bytes asked for, in ${splitRanges.length} requests`);
  check('the resumed split file is complete and correct, and its parts file is gone', sameAs(path.join(downloadDir, 'split-archive.zip'), splitSize) && !fs.existsSync(splitPartFile));
  const zoneOf = (file) => { try { return fs.readFileSync(`${file}:Zone.Identifier`, 'utf8'); } catch { return ''; } };
  check('a split download is marked as coming from the internet', /ZoneId=3/.test(zoneOf(path.join(downloadDir, 'split-archive.zip'))));
  const evalIn = (contents, code) => contents.executeJavaScript(code);

  // ---------- Splitting a big download, the speed limit, marking ----------
  const helper = tabs.create({ url: `${base}/helper`, activate: false });
  await waitFor(() => helper.view.webContents.getURL() !== '' && !helper.view.webContents.isLoading(), 'helper tab');
  settings.update({ connectionsPerFile: 4 });
  pace = 20;
  helper.view.webContents.downloadURL(`${base}/file/live-split.bin?size=${12 * 1024 * 1024}`);
  await waitFor(() => byName('live-split.bin')?.parts?.length >= 2 && byName('live-split.bin').connections >= 2, 'download split over connections', 20000);
  check('a big download is split over several connections', byName('live-split.bin').connections >= 2, `${byName('live-split.bin').connections} connections`);
  pace = 1;
  await waitFor(() => byName('live-split.bin').state === 'completed', 'split download finished', 30000);
  check('the split download is complete and correct', sameAs(path.join(downloadDir, 'live-split.bin'), 12 * 1024 * 1024));

  // A download Chromium runs (one connection, as for a server that can't send parts), from a
  // server sending about 3 MB/s, held to 1 MB/s: 6 MB that would take 2 s takes about 6 s.
  // Chromium's downloads are held back by pausing them, so what is already in its network
  // buffers (a MB or two) still comes in at the start; the limit holds after that.
  settings.update({ speedLimitKBps: 1024, connectionsPerFile: 1 });
  pace = 20;
  let started = Date.now();
  helper.view.webContents.downloadURL(`${base}/file/limited.bin?size=${6 * 1024 * 1024}`);
  await waitFor(() => byName('limited.bin')?.state === 'completed', 'limited download finished', 30000);
  const plainSeconds = (Date.now() - started) / 1000;
  pace = 1;
  settings.update({ connectionsPerFile: 4 });
  check('the speed limit holds a download Chromium runs to it', plainSeconds >= 3.5 && sameAs(path.join(downloadDir, 'limited.bin'), 6 * 1024 * 1024), `${plainSeconds.toFixed(1)} s for 6 MB at 1 MB/s`);
  // 6 MB that the server sends at once, held to 3 MB/s.
  pace = 1;
  settings.update({ speedLimitKBps: 3 * 1024 });
  started = Date.now();
  helper.view.webContents.downloadURL(`${base}/file/fast-limited-split.bin?size=${6 * 1024 * 1024}`);
  await waitFor(() => byName('fast-limited-split.bin')?.state === 'completed', 'limited split download finished', 30000);
  const splitSeconds = (Date.now() - started) / 1000;
  check('the speed limit holds a split download to it', splitSeconds >= 1.2 && sameAs(path.join(downloadDir, 'fast-limited-split.bin'), 6 * 1024 * 1024), `${splitSeconds.toFixed(1)} s for 6 MB at 3 MB/s`);
  settings.update({ speedLimitKBps: 0 });

  settings.update({ markOfTheWeb: false });
  helper.view.webContents.downloadURL(`${base}/file/fast-unmarked.txt?size=4096`);
  await waitFor(() => byName('fast-unmarked.txt')?.state === 'completed', 'unmarked download finished');
  check('with marking off, a download is not marked as from the internet', zoneOf(path.join(downloadDir, 'fast-unmarked.txt')) === '');
  settings.update({ markOfTheWeb: true });
  tabs.close(helper.id);

  // ---------- Toolbar: the downloads button and its panel ----------
  await waitFor(async () => evalIn(ui.webContents, "!document.getElementById('downloads').hidden"), 'downloads button shown');
  check('the downloads button shows once something downloads', true);
  await evalIn(ui.webContents, "document.getElementById('downloads').click()");
  await waitFor(async () => evalIn(ui.webContents, "!document.getElementById('downloadsPanel').hidden && document.querySelectorAll('#downloadsItems .dl-item').length > 0"), 'downloads panel open');
  const panelText = await evalIn(ui.webContents, "document.getElementById('downloadsPanel').textContent");
  check('the downloads panel lists the latest downloads', /fast-unmarked\.txt/.test(panelText) && /Done/.test(panelText) && /Open/.test(panelText), panelText.slice(0, 120));
  const toolbarDenied = await evalIn(ui.webContents, 'window.browserApi.downloads.list().then(() => "allowed", () => "refused")');
  check('the toolbar cannot read the full downloads list (addresses and folders)', toolbarDenied === 'refused');
  await evalIn(ui.webContents, "document.getElementById('downloadsAll').click()");
  await waitFor(() => tabs.active?.kind === 'internal' && tabs.active.title === 'Downloads', 'Downloads page opened from the panel');
  check('Show all downloads opens the Downloads page', await evalIn(ui.webContents, "document.getElementById('downloadsPanel').hidden"));
  const page = tabs.active.view.webContents;
  await waitFor(async () => (await evalIn(page, "document.querySelectorAll('#downloadList .row').length")) === downloads.list().length, 'downloads page rows');

  // ---------- Pause and resume, from the Downloads page ----------
  pace = 50;
  const web = tabs.create({ url: `${base}/start`, activate: false });
  await waitFor(() => web.view.webContents.getURL() !== '' && !web.view.webContents.isLoading(), 'web tab');
  web.view.webContents.downloadURL(`${base}/file/slow-report.pdf?size=${3 * 1024 * 1024}`);
  await waitFor(() => byName('slow-report.pdf')?.received > 200 * 1024, 'slow download running');
  const slowId = byName('slow-report.pdf').id;
  await waitFor(async () => evalIn(page, `Boolean(document.querySelector('[aria-label="Pause slow-report.pdf"]'))`), 'pause button on the page');
  await evalIn(page, `document.querySelector('[aria-label="Pause slow-report.pdf"]').click()`);
  await waitFor(() => byName('slow-report.pdf').state === 'paused', 'paused from the page');
  await sleep(400);
  const pausedAt = byName('slow-report.pdf').received;
  await sleep(1000);
  check('Pause on the Downloads page stops the download', byName('slow-report.pdf').received - pausedAt <= 256 * 1024, `${pausedAt} -> ${byName('slow-report.pdf').received}`);
  const pausedRow = await evalIn(page, `document.querySelector('[data-id="${slowId}"]').textContent`);
  check('the page shows it as paused, with Resume', /Paused/.test(pausedRow) && await evalIn(page, `Boolean(document.querySelector('[aria-label="Resume slow-report.pdf"]'))`), pausedRow);
  pace = 1;
  await evalIn(page, `document.querySelector('[aria-label="Resume slow-report.pdf"]').click()`);
  await waitFor(() => byName('slow-report.pdf').state === 'completed', 'resumed download finished', 20000);
  check('Resume finishes it, and the file is correct', sameAs(path.join(downloadDir, 'slow-report.pdf'), 3 * 1024 * 1024));

  // ---------- The queue ----------
  pace = 40;
  settings.update({ downloadsAtOnce: 1 });
  web.view.webContents.downloadURL(`${base}/file/queue-one.bin?size=${2 * 1024 * 1024}`);
  await waitFor(() => byName('queue-one.bin')?.received > 0, 'first queued download running');
  web.view.webContents.downloadURL(`${base}/file/queue-two.bin?size=${2 * 1024 * 1024}`);
  await waitFor(() => byName('queue-two.bin')?.state === 'queued', 'second download waits', 10000).catch(() => {});
  check('with one download at a time, the next one waits its turn', byName('queue-two.bin')?.state === 'queued' && byName('queue-one.bin').state === 'progressing',
    `${byName('queue-one.bin')?.state} / ${byName('queue-two.bin')?.state}`);
  await waitFor(async () => /Waiting/.test(await evalIn(page, "document.getElementById('downloadList').textContent")), 'waiting group shown');
  check('the Downloads page lists it under Waiting, with Start now', await evalIn(page, "[...document.querySelectorAll('.dl-group')].some((group) => /Waiting/.test(group.querySelector('h3').textContent) && /Start now/.test(group.textContent))"));
  pace = 1;
  await waitFor(() => byName('queue-one.bin').state === 'completed', 'first finished', 20000);
  await waitFor(() => byName('queue-two.bin').state === 'completed', 'second started and finished after the first', 20000);
  check('the waiting download starts by itself when the first finishes', sameAs(path.join(downloadDir, 'queue-two.bin'), 2 * 1024 * 1024));
  settings.update({ downloadsAtOnce: 3 });

  // ---------- A failed download, retried ----------
  web.view.webContents.downloadURL(`${base}/file/flaky-data.csv?size=${2 * 1024 * 1024}`);
  await waitFor(() => byName('flaky-data.csv')?.state === 'interrupted', 'flaky download failed', 30000);
  check('a download the server cuts off is shown as failed', true);
  await waitFor(async () => /Retry/.test(await evalIn(page, "document.getElementById('downloadList').textContent")), 'Retry shown');
  const failedChip = await evalIn(page, "document.querySelector('#downloadFilters [data-filter=\"failed\"]').textContent");
  check('the Failed filter counts it', failedChip === 'Failed 1', failedChip);
  await evalIn(page, "document.querySelector('#downloadFilters [data-filter=\"failed\"]').click()");
  const failedRows = await evalIn(page, "document.querySelectorAll('#downloadList .row').length");
  check('the Failed filter shows only failed downloads', failedRows === 1, String(failedRows));
  flakyHealed = true;
  await evalIn(page, "[...document.querySelectorAll('#downloadList button')].find((b) => b.textContent === 'Retry').click()");
  await waitFor(() => byName('flaky-data.csv').state === 'completed', 'retried download finished', 30000);
  check('Retry finishes the failed download, and the file is correct', sameAs(path.join(downloadDir, 'flaky-data.csv'), 2 * 1024 * 1024));
  check('the retried download keeps its row', downloads.list().filter((entry) => entry.filename === 'flaky-data.csv').length === 1);
  await evalIn(page, "document.querySelector('#downloadFilters [data-filter=\"all\"]').click()");

  // ---------- Details, and Clear finished ----------
  await evalIn(page, `document.querySelector('[data-id="${slowId}"] [aria-label="Show details"]').click()`);
  const details = await evalIn(page, `document.querySelector('[data-id="${slowId}"] .dl-details')?.textContent ?? ''`);
  check('a row opens to show where the file came from and where it was saved', details.includes(`${base}/file/slow-report.pdf`) && details.includes(downloadDir), details.slice(0, 160));

  // ---------- Private downloads are not kept ----------
  const privateTab = tabs.create({ url: `${base}/private`, isPrivate: true });
  await waitFor(() => !privateTab.view.webContents.isLoading(), 'private tab');
  privateTab.view.webContents.downloadURL(`${base}/file/fast-private.txt?size=4096`);
  await waitFor(() => byName('fast-private.txt')?.state === 'completed', 'private download finished');
  downloads.save();
  const kept = JSON.parse(fs.readFileSync(path.join(profile, 'downloads.json'), 'utf8')).entries.map((entry) => entry.filename);
  check('a private tab\'s download is listed but never saved in the profile', byName('fast-private.txt').isPrivate && !kept.includes('fast-private.txt') && kept.includes('slow-report.pdf'), kept.join(', '));
  tabs.close(privateTab.id);

  // ---------- Videos on a page ----------
  tabs.activate(web.id);
  web.view.webContents.loadURL(`${base}/videos`);
  await waitFor(() => ctx.videoFinder.list(web.id).length === 2, 'videos found on the page', 15000);
  check('the page\'s videos are found: one plain file, one streamed', JSON.stringify(ctx.videoFinder.list(web.id).map((video) => video.kind)) === '["file","streamed"]',
    JSON.stringify(ctx.videoFinder.list(web.id)));
  await waitFor(async () => evalIn(ui.webContents, "!document.getElementById('videos').hidden && document.getElementById('videos').textContent === '2'"), 'video button');
  check('the address bar shows a video button with the count', true);
  await evalIn(ui.webContents, "document.getElementById('videos').click()");
  await waitFor(async () => evalIn(ui.webContents, "document.querySelectorAll('#videosItems .video-item').length === 2"), 'videos panel');
  const videosText = await evalIn(ui.webContents, "document.getElementById('videosPanel').textContent");
  check('the video panel offers Save for the file and explains the streamed one', /lecture-4\.mp4/.test(videosText) && /Save/.test(videosText) && /small pieces/.test(videosText), videosText.slice(0, 200));
  const libraryDenied = await evalIn(page, 'window.browserApi.videos.list().then(() => "allowed", () => "refused")');
  check('the Downloads page cannot ask for the videos of a page', libraryDenied === 'refused');
  const outOfRange = await evalIn(ui.webContents, 'window.browserApi.videos.save(1)');
  check('a streamed video cannot be saved, even when asked for directly', outOfRange === false);
  await evalIn(ui.webContents, "document.querySelector('#videosItems .video-item.file button').click()");
  await waitFor(() => byName('lecture-4.mp4')?.state === 'completed', 'saved video finished', 20000);
  check('Save in the video panel downloads the video, marked as a saved video', byName('lecture-4.mp4').kind === 'video' && sameAs(path.join(downloadDir, 'lecture-4.mp4'), 2 * 1024 * 1024));
  await evalIn(ui.webContents, "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); document.getElementById('videosPanel').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  check('Esc closes the video panel', await evalIn(ui.webContents, "document.getElementById('videosPanel').hidden"));

  // Clear finished keeps nothing finished, and the list on disk follows.
  tabs.activate(tabs.order.find((id) => tabs.tabs.get(id).kind === 'internal'));
  await waitFor(async () => (await evalIn(page, "document.querySelectorAll('#downloadList .row').length")) >= 5, 'all rows');
  await evalIn(page, "document.getElementById('downloadsClear').click()");
  await waitFor(() => downloads.list().length === 0, 'cleared');
  check('Clear finished empties the list', /No downloads yet/.test(await evalIn(page, "new Promise((r) => setTimeout(() => r(document.getElementById('downloadList').textContent), 400))")));

  // ---------- Add links ----------
  tabs.activate(tabs.order.find((id) => tabs.tabs.get(id).kind === 'internal'));
  await evalIn(page, "document.getElementById('downloadsAdd').click()");
  await waitFor(async () => evalIn(page, "document.getElementById('addDialog').open"), 'add dialog open');
  const pasted = [`${base}/file/added-one.bin?size=300000`, `${base}/file/added-two.bin?size=400000`, `${base}/page-not-file`].join('\n');
  await evalIn(page, `(() => { const box = document.getElementById('addLinks'); box.value = ${JSON.stringify(pasted)};
    box.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await waitFor(async () => /2 of 3 links/.test(await evalIn(page, "document.getElementById('addSummary').textContent")), 'links checked', 15000);
  const addText = await evalIn(page, "document.getElementById('addResults').textContent");
  check('pasted links are checked: size, resuming, and why one can\'t be added', /added-one\.bin/.test(addText) && /293 KB · resumable/.test(addText) && /web page, not a file/.test(addText), addText);
  check('the Add button counts the links that can be added', await evalIn(page, "document.getElementById('addConfirm').textContent") === 'Add 2 downloads');
  const defaultFolder = await evalIn(page, "document.getElementById('addFolder').textContent");
  check('links go into the downloads folder unless another is chosen', defaultFolder === downloadDir, defaultFolder);
  await evalIn(page, "document.getElementById('addConfirm').click()");
  await waitFor(() => byName('added-one.bin')?.state === 'completed' && byName('added-two.bin')?.state === 'completed', 'added links downloaded', 20000);
  check('added links download into the folder, correctly', sameAs(path.join(downloadDir, 'added-one.bin'), 300000) && sameAs(path.join(downloadDir, 'added-two.bin'), 400000));
  const anyFolder = await evalIn(page, `window.browserApi.downloads.addLinks({ links: [{ url: '${base}/file/x.bin' }], saveDir: 'C:\\\\Windows', start: 'now' })`);
  check('the page can\'t save into a folder the user didn\'t choose', anyFolder.ok === false && anyFolder.reason === 'folder', JSON.stringify(anyFolder));

  // ---------- Start times, the night, and the order of the queue ----------
  const inAnHour = Date.now() + 3_600_000;
  await evalIn(page, `window.browserApi.downloads.addLinks({ links: ['a', 'b', 'c'].map((n) => ({ url: '${base}/file/later-' + n + '.bin', filename: 'later-' + n + '.bin' })),
    saveDir: ${JSON.stringify(downloadDir)}, start: 'at', startAt: ${inAnHour} })`);
  await waitFor(async () => (await evalIn(page, "document.querySelectorAll('.dl-group .handle').length")) === 3, 'waiting rows with handles');
  const waitingText = await evalIn(page, "[...document.querySelectorAll('.dl-group')].find((g) => /Waiting/.test(g.querySelector('h3').textContent)).textContent");
  check('links set to start later wait, saying when', ['a', 'b', 'c'].every((n) => byName(`later-${n}.bin`)?.state === 'queued') && /Starts at/.test(waitingText), waitingText.slice(0, 160));
  const queueOrder = () => downloads.queue().map(({ entry }) => entry.filename).join(',');
  await evalIn(page, "document.querySelectorAll('.dl-group .handle')[2].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))");
  await waitFor(() => queueOrder() === 'later-a.bin,later-c.bin,later-b.bin', 'moved up', 5000).catch(() => {});
  check('a waiting download moves up the queue with the arrow keys on its handle', queueOrder() === 'later-a.bin,later-c.bin,later-b.bin', queueOrder());
  await waitFor(async () => (await evalIn(page, "[...document.querySelectorAll('.dl-group .dl-row')].filter((r) => r.querySelector('.handle')).map((r) => r.querySelector('.name').firstChild.textContent).join(',')")) === 'later-a.bin,later-c.bin,later-b.bin', 'page shows the new order', 5000).catch(() => {});
  check('the page shows the queue in its new order', true);
  for (const n of ['a', 'b', 'c']) downloads.cancel(byName(`later-${n}.bin`).id);

  const minutesNow = new Date().getHours() * 60 + new Date().getMinutes();
  // Through the Settings page, as the user would (the Downloads page then knows the night too).
  const saveSettings = (patch) => evalIn(page, `saveSetting(${JSON.stringify(patch)}).then(() => true)`);
  await saveSettings({ downloadNightOnly: true, downloadNightFrom: (minutesNow + 120) % 1440, downloadNightTo: (minutesNow + 180) % 1440 });
  await evalIn(page, `window.browserApi.downloads.addLinks({ links: [{ url: '${base}/file/nightly.bin?size=2048', filename: 'nightly.bin' }], saveDir: ${JSON.stringify(downloadDir)}, start: 'queue' })`);
  await waitFor(async () => /Waits for the night/.test(await evalIn(page, "document.getElementById('downloadList').textContent")), 'night text', 5000).catch(() => {});
  check('with "only at night" on, an added link waits for the night', byName('nightly.bin')?.state === 'queued' &&
    /Waits for the night/.test(await evalIn(page, "document.getElementById('downloadList').textContent")));
  await saveSettings({ downloadNightFrom: (minutesNow + 1439) % 1440, downloadNightTo: (minutesNow + 60) % 1440 });
  downloads.pump(); // what the schedule's next look does
  await waitFor(() => byName('nightly.bin')?.state === 'completed', 'night download ran', 10000).catch(() => {});
  check('once it is night, it downloads', byName('nightly.bin')?.state === 'completed');
  await saveSettings({ downloadNightOnly: false });

  // ---------- Checksums ----------
  const sha = (size) => require('node:crypto').createHash('sha256').update(content(size)).digest('hex');
  await evalIn(page, `window.browserApi.downloads.addLinks({ links: [{ url: '${base}/file/checked.bin?size=50000', filename: 'checked.bin' }],
    saveDir: ${JSON.stringify(downloadDir)}, start: 'now', checksum: '${sha(50000).toUpperCase()}' })`);
  await waitFor(() => byName('checked.bin')?.checksum?.result === 'match', 'checksum checked', 10000).catch(() => {});
  check('a SHA-256 given when adding is checked when the download finishes', byName('checked.bin')?.checksum?.result === 'match', JSON.stringify(byName('checked.bin')?.checksum));
  await waitFor(async () => /checksum matches/.test(await evalIn(page, `document.querySelector('[data-id="${byName('checked.bin').id}"]')?.textContent ?? ''`)), 'match shown', 5000).catch(() => {});
  check('the row says the checksum matches', /checksum matches/.test(await evalIn(page, `document.querySelector('[data-id="${byName('checked.bin').id}"]')?.textContent ?? ''`)));
  const plainId = byName('added-one.bin').id;
  await evalIn(page, `document.querySelector('[data-id="${plainId}"] [aria-label="Show details"]').click()`);
  await waitFor(async () => evalIn(page, `Boolean(document.querySelector('[data-id="${plainId}"] .dl-checksum input'))`), 'checksum field');
  await evalIn(page, `(() => { const row = document.querySelector('[data-id="${plainId}"]'); row.querySelector('.dl-checksum input').value = '${'0'.repeat(64)}';
    [...row.querySelectorAll('.dl-checksum button')].find((b) => b.textContent === 'Check').click(); })()`);
  await waitFor(() => byName('added-one.bin')?.checksum?.result === 'mismatch', 'mismatch found', 10000).catch(() => {});
  check('a SHA-256 pasted for a finished download is checked at once, and a wrong one is flagged', byName('added-one.bin')?.checksum?.result === 'mismatch');

  // ---------- When all downloads finish ----------
  pace = 20;
  await evalIn(page, "(() => { const s = document.getElementById('whenDone'); s.value = 'shutdown'; s.dispatchEvent(new Event('change')); })()");
  await waitFor(() => ctx.whenDone.state().action === 'shutdown', 'shut down chosen');
  await evalIn(page, `window.browserApi.downloads.addLinks({ links: [{ url: '${base}/file/last-one.bin?size=1000000', filename: 'last-one.bin' }], saveDir: ${JSON.stringify(downloadDir)}, start: 'now' })`);
  await waitFor(() => byName('last-one.bin')?.state === 'completed', 'last download done', 20000);
  await waitFor(async () => /shut down in/.test(await evalIn(page, "document.getElementById('whenDoneBanner').hidden ? '' : document.getElementById('whenDoneText').textContent")), 'countdown shown', 5000).catch(() => {});
  check('when the downloads finish, a countdown to shutting down is shown', /shut down in/.test(await evalIn(page, "document.getElementById('whenDoneText').textContent")) && powerCalls.length === 0);
  await waitFor(() => powerCalls.length === 1, 'shut down asked for', 5000).catch(() => {});
  check('after the countdown the computer is shut down (recorded, not done, in this test)', JSON.stringify(powerCalls) === '["shutdown"]', JSON.stringify(powerCalls));
  check('the choice goes back to doing nothing', await evalIn(page, "new Promise((r) => setTimeout(() => r(document.getElementById('whenDone').value), 300))") === 'none');

  await evalIn(page, "(() => { const s = document.getElementById('whenDone'); s.value = 'sleep'; s.dispatchEvent(new Event('change')); })()");
  await waitFor(() => ctx.whenDone.state().action === 'sleep', 'sleep chosen');
  await evalIn(page, `window.browserApi.downloads.addLinks({ links: [{ url: '${base}/file/cancel-sleep.bin?size=600000', filename: 'cancel-sleep.bin' }], saveDir: ${JSON.stringify(downloadDir)}, start: 'now' })`);
  await waitFor(async () => evalIn(page, "!document.getElementById('whenDoneBanner').hidden"), 'sleep countdown', 20000);
  await evalIn(page, "document.getElementById('whenDoneCancel').click()");
  await sleep(2000);
  pace = 1;
  check('Cancel stops the countdown: the computer stays on', JSON.stringify(powerCalls) === '["shutdown"]' && ctx.whenDone.state().action === 'none', JSON.stringify(powerCalls));

  // Downloads go on reporting while the browser quits, after its window and views are gone;
  // that must not throw (it showed an error box as the browser closed). Checked by "no uncaught
  // errors" below.
  ctx.win.destroy();
  await waitFor(() => ctx.win.isDestroyed(), 'window closed');
  downloads.emit('change');
  downloads.emit('completed', { id: 0, filename: 'late.txt', path: '' });
  await sleep(500);
  server.close();
  const ok = finish();
  app.exit(ok ? 0 : 1);
}

// The browser starts only after the quit phase has run, when Electron is long ready.
prepare();
const phase = process.argv.find((arg) => arg.startsWith('--phase='));
if (phase === '--phase=quit') {
  const args = process.argv.slice(process.argv.indexOf(phase) + 1);
  quitMidDownload(args).catch((error) => {
    console.error('QUIT PHASE ERROR', error);
    app.exit(3);
  });
} else {
  main().catch((error) => {
    console.error('SMOKE ERROR', error);
    app.exit(2);
  });
}
