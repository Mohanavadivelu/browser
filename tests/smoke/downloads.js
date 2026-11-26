'use strict';

// Smoke test for the download manager: pause and resume, the queue, retrying a failed download,
// picking up after the browser was quit mid-download, private downloads, the toolbar's downloads
// button and panel, the Downloads page, and saving a video from a page.
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

// The same bytes for every request, so a resumed file can be compared with the original.
function content(size) {
  const data = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) data[i] = (i * 7 + 3) % 251;
  return data;
}

async function quitMidDownload([profile, downloadDir, url]) {
  const ctx = await start({ userDataDir: profile, skipSingleInstanceLock: true, blockerFilters: '', downloadDir });
  await waitFor(() => ctx.win.isVisible(), 'window ready', 30000);
  ctx.tabs.navigate(url);
  await waitFor(() => ctx.downloads.list()[0]?.received > 600 * 1024, 'part of the download', 30000);
  // As if the user closed the browser while it downloads.
  app.quit();
}

async function main() {
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
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
    const range = /bytes=(\d+)-/.exec(req.headers.range ?? '');
    let from = range ? Number(range[1]) : 0;
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
      res.setHeader('content-range', `bytes ${from}-${size - 1}/${size}`);
    }
    res.setHeader('content-length', String(size - from));
    const cutAt = name.startsWith('flaky') && !flakyHealed ? 512 * 1024 : Infinity;
    const step = () => {
      if (res.destroyed) return;
      if (from >= cutAt) { res.destroy(); return; }
      if (from >= size) { res.end(); return; }
      const next = Math.min(size, from + 64 * 1024, cutAt);
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
  const bigSize = 6 * 1024 * 1024;
  pace = 60;
  const child = spawn(process.execPath, [__filename, '--phase=quit', profile, downloadDir, `${base}/file/big-archive.zip?size=${bigSize}`], { stdio: 'inherit' });
  const code = await new Promise((resolve) => child.on('exit', resolve));
  const saved = JSON.parse(fs.readFileSync(path.join(profile, 'downloads.json'), 'utf8'));
  const savedEntry = saved.entries.find((entry) => entry.filename === 'big-archive.zip');
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
  const ctx = await start({ userDataDir: profile, skipSingleInstanceLock: true, blockerFilters: '', downloadDir, quitOnClose: false });
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
  const evalIn = (contents, code) => contents.executeJavaScript(code);

  // ---------- Toolbar: the downloads button and its panel ----------
  await waitFor(async () => evalIn(ui.webContents, "!document.getElementById('downloads').hidden"), 'downloads button shown');
  check('the downloads button shows once something downloads', true);
  await evalIn(ui.webContents, "document.getElementById('downloads').click()");
  await waitFor(async () => evalIn(ui.webContents, "!document.getElementById('downloadsPanel').hidden && document.querySelectorAll('#downloadsItems .dl-item').length > 0"), 'downloads panel open');
  const panelText = await evalIn(ui.webContents, "document.getElementById('downloadsPanel').textContent");
  check('the downloads panel lists the latest downloads', /big-archive\.zip/.test(panelText) && /Done/.test(panelText) && /Open/.test(panelText), panelText.slice(0, 120));
  const toolbarDenied = await evalIn(ui.webContents, 'window.browserApi.downloads.list().then(() => "allowed", () => "refused")');
  check('the toolbar cannot read the full downloads list (addresses and folders)', toolbarDenied === 'refused');
  await evalIn(ui.webContents, "document.getElementById('downloadsAll').click()");
  await waitFor(() => tabs.active?.kind === 'internal' && tabs.active.title === 'Downloads', 'Downloads page opened from the panel');
  check('Show all downloads opens the Downloads page', await evalIn(ui.webContents, "document.getElementById('downloadsPanel').hidden"));
  const page = tabs.active.view.webContents;
  await waitFor(async () => (await evalIn(page, "document.querySelectorAll('#downloadList .row').length")) === 1, 'downloads page rows');

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

  ctx.win.destroy();
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
