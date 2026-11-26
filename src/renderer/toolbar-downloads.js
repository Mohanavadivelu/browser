'use strict';

// ---------- The downloads button and the video button ----------
// The downloads button appears once something downloads. Its ring shows how far the running
// downloads have got; a click opens a panel with the latest few, which can be paused, resumed
// or (when done) opened, and a link to the Downloads page.
// The video button in the address bar counts the videos on the page; its panel saves the plain
// files and says why the others (streamed in pieces, or protected by the site) can't be saved.
let downloadsBrief = { visible: false, active: 0, waiting: 0, failed: 0, percent: null, speed: 0, items: [] };
let downloadsOpen = false;
let videosOpen = false;
let videosSeq = 0;
const RING = 2 * Math.PI * 13;

function svgOf(paths, { fill = false } = {}) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  if (fill) svg.setAttribute('class', 'filled');
  for (const d of paths) {
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

const ARROW = ['M12 5v10', 'M7.5 11l4.5 4.5 4.5-4.5', 'M6 20h12'];
const VIDEO = ['M5 6h9a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z', 'M16 10l5-3v10l-5-3z'];

function sizeText(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

// ---------- Downloads ----------
function renderDownloadsButton() {
  const buttonNode = $('downloads');
  const brief = downloadsBrief;
  buttonNode.hidden = !brief.visible;
  if (buttonNode.hidden) {
    if (downloadsOpen) closeDownloads();
    return;
  }
  const ring = document.createElementNS(SVG, 'svg');
  ring.setAttribute('class', 'ring');
  ring.setAttribute('viewBox', '0 0 30 30');
  ring.setAttribute('aria-hidden', 'true');
  if (brief.active > 0) {
    const track = document.createElementNS(SVG, 'circle');
    for (const [key, value] of [['cx', 15], ['cy', 15], ['r', 13], ['class', 'track']]) track.setAttribute(key, value);
    const done = document.createElementNS(SVG, 'circle');
    const shown = brief.percent === null ? 0.25 : brief.percent / 100;
    for (const [key, value] of [['cx', 15], ['cy', 15], ['r', 13], ['class', brief.percent === null ? 'done unknown' : 'done'],
      ['stroke-dasharray', `${(RING * shown).toFixed(1)} ${RING.toFixed(1)}`], ['transform', 'rotate(-90 15 15)']]) done.setAttribute(key, value);
    ring.append(track, done);
  }
  const parts = [ring, svgOf(ARROW)];
  if (brief.waiting > 0) parts.push(element('span', 'badge', String(brief.waiting)));
  else if (brief.failed > 0) parts.push(element('span', 'badge failed', '!'));
  buttonNode.replaceChildren(...parts);
  buttonNode.classList.toggle('busy', brief.active > 0);
  const label = brief.active > 0
    ? `Downloads: ${brief.active} downloading${brief.percent === null ? '' : `, ${brief.percent}% done`}`
    : brief.failed > 0 ? `Downloads: ${brief.failed} failed` : 'Downloads';
  buttonNode.title = `${label} (Ctrl+J for all)`;
  buttonNode.setAttribute('aria-label', label);
  buttonNode.setAttribute('aria-expanded', String(downloadsOpen));
  if (downloadsOpen) drawDownloads();
}

function downloadLine(entry) {
  const size = entry.total > 0 ? `${sizeText(entry.received)} of ${sizeText(entry.total)}` : sizeText(entry.received);
  switch (entry.state) {
    case 'progressing': return entry.speed > 0 ? `${size} · ${sizeText(entry.speed)}/s` : size;
    case 'paused': return `Paused · ${size}`;
    case 'queued': return 'Waiting for its turn';
    case 'interrupted': return 'Failed: see the Downloads page';
    case 'completed': return entry.missing ? 'Moved or deleted' : `Done · ${sizeText(entry.total || entry.received)}`;
    case 'cancelled': return 'Cancelled';
    case 'blocked': return 'Blocked';
    default: return entry.state;
  }
}

function downloadPanelRow(entry) {
  const row = element('li', `dl-item ${entry.state}`);
  const main = element('div', 'dl-main');
  const name = element('div', 'dl-name', entry.filename);
  name.title = entry.filename;
  main.append(name);
  if (['progressing', 'paused', 'queued'].includes(entry.state) && entry.total > 0) {
    const bar = element('div', 'dl-bar');
    const fill = element('div', 'dl-fill');
    fill.style.width = `${Math.min(100, (entry.received / entry.total) * 100).toFixed(1)}%`;
    bar.append(fill);
    main.append(bar);
  }
  main.append(element('div', 'dl-line', downloadLine(entry)));
  row.append(main);
  const act = (label, onClick, icon, className = '') => {
    const node = element('button', `dl-act ${className}`.trim());
    node.type = 'button';
    if (icon) {
      node.append(svgOf(icon.paths, { fill: icon.fill }));
      node.setAttribute('aria-label', `${label} ${entry.filename}`);
      node.title = label;
    } else {
      node.textContent = label;
    }
    node.addEventListener('click', onClick);
    row.append(node);
  };
  if (entry.state === 'progressing' || entry.state === 'queued') act('Pause', () => api.downloads.pause(entry.id), { paths: ['M9 5v14', 'M15 5v14'] });
  else if (entry.state === 'paused') act('Resume', () => api.downloads.resume(entry.id), { paths: ['M8 5l11 7-11 7z'], fill: true }, 'primary');
  else if (entry.state === 'completed' && !entry.missing) act('Open', () => api.downloads.open(entry.id));
  return row;
}

function drawDownloads() {
  const panel = $('downloadsPanel');
  const brief = downloadsBrief;
  const summary = [];
  if (brief.active) summary.push(`${brief.active} downloading`);
  if (brief.speed > 0) summary.push(`${sizeText(brief.speed)}/s`);
  if (brief.failed) summary.push(`${brief.failed} failed`);
  $('downloadsSummary').textContent = summary.join(' · ');
  const list = $('downloadsItems');
  // Rebuilt only when what is shown changed, so a button is not swapped under the pointer.
  const key = JSON.stringify(brief.items.map((entry) => [entry.id, entry.state, entry.missing, Math.floor((entry.received / (entry.total || 1)) * 200), entry.speed > 0 ? Math.round(Math.log2(entry.speed)) : 0]));
  if (list.dataset.key !== key) {
    list.dataset.key = key;
    list.replaceChildren(...(brief.items.length ? brief.items.map(downloadPanelRow) : [element('li', 'dl-empty', 'Nothing downloaded yet.')]));
  }
  const anchor = $('downloads').getBoundingClientRect();
  panel.style.top = `${Math.round(anchor.bottom + 8)}px`;
  panel.style.left = `${Math.max(8, Math.round(anchor.right + 8 - panel.offsetWidth))}px`;
  requestOverlay('downloads', panel.getBoundingClientRect().bottom + 12 - chromeHeight());
}

async function openDownloads() {
  if (downloadsOpen) {
    closeDownloads();
    return;
  }
  if (starBookmark) await closeStar(true);
  closeShield();
  closeVideos();
  downloadsOpen = true;
  $('downloadsPanel').hidden = false;
  $('downloads').setAttribute('aria-expanded', 'true');
  downloadsBrief = await api.downloads.brief();
  if (!downloadsOpen) return;
  drawDownloads();
  $('downloadsAll').focus();
}

function closeDownloads() {
  if (!downloadsOpen) return;
  downloadsOpen = false;
  $('downloadsPanel').hidden = true;
  $('downloads').setAttribute('aria-expanded', 'false');
  requestOverlay('downloads', 0);
}

function showDownloadsBrief(brief) {
  downloadsBrief = brief;
  renderDownloadsButton();
}

// ---------- Videos on the page ----------
function renderVideosButton(count) {
  const buttonNode = $('videos');
  const tab = activeTab();
  buttonNode.hidden = !(count > 0) || tab?.kind !== 'web';
  if (buttonNode.hidden) {
    if (videosOpen) closeVideos();
    return;
  }
  buttonNode.replaceChildren(svgOf(VIDEO), element('span', 'count', String(count)));
  const label = `${count} video${count === 1 ? '' : 's'} on this page`;
  buttonNode.title = label;
  buttonNode.setAttribute('aria-label', label);
  buttonNode.setAttribute('aria-expanded', String(videosOpen));
}

function videoFacts(video) {
  const facts = [];
  if (video.width && video.height) facts.push(`${video.width}×${video.height}`);
  if (video.duration) {
    const minutes = Math.floor(video.duration / 60);
    facts.push(minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : minutes ? `${minutes} min` : `${video.duration} s`);
  }
  return facts.join(' · ');
}

function videoRow(video) {
  const row = element('li', `video-item ${video.kind}`);
  const main = element('div', 'video-main');
  if (video.kind === 'file') {
    const name = element('div', 'video-name', video.name);
    name.title = video.title ? `${video.title} (${video.name})` : video.name;
    main.append(name, element('div', 'video-line', videoFacts(video) || 'Video file'));
    row.append(main);
    const save = element('button', 'primary');
    save.type = 'button';
    save.append(svgOf(ARROW), 'Save');
    save.setAttribute('aria-label', `Save ${video.name}`);
    save.addEventListener('click', async () => {
      save.disabled = true;
      const ok = await api.videos.save(video.index);
      save.replaceChildren(ok ? 'Saving…' : 'Gone');
    });
    row.append(save);
  } else {
    const title = video.title || (video.kind === 'streamed' ? 'Streamed video' : 'Protected video');
    main.append(element('div', 'video-name muted', title));
    main.append(element('div', 'video-line', video.kind === 'streamed'
      ? 'This video plays in small pieces, so it can\'t be saved as one file.'
      : 'The site protects this video, so it can only be watched there.'));
    row.append(main);
  }
  return row;
}

async function refreshVideos() {
  const seq = ++videosSeq;
  const videos = await api.videos.list();
  if (!videosOpen || seq !== videosSeq) return;
  const savable = videos.filter((video) => video.kind === 'file').length;
  $('videosNote').textContent = videos.length === 0 ? 'No videos found on this page any more.'
    : savable ? 'Save a copy to watch offline. It is listed on the Downloads page.'
      : 'None of the videos here can be saved.';
  $('videosItems').replaceChildren(...videos.map(videoRow));
  const panel = $('videosPanel');
  const anchor = $('videos').getBoundingClientRect();
  panel.style.top = `${Math.round(anchor.bottom + 10)}px`;
  panel.style.left = `${Math.max(8, Math.round(anchor.right + 12 - panel.offsetWidth))}px`;
  requestOverlay('videos', panel.getBoundingClientRect().bottom + 12 - chromeHeight());
}

async function openVideos() {
  if (videosOpen) {
    closeVideos();
    return;
  }
  if (starBookmark) await closeStar(true);
  closeShield();
  closeDownloads();
  videosOpen = true;
  $('videosPanel').hidden = false;
  $('videos').setAttribute('aria-expanded', 'true');
  $('videosItems').replaceChildren();
  $('videosNote').textContent = 'Looking for videos…';
  await refreshVideos();
  if (videosOpen) $('videosPanel').querySelector('button, [tabindex]')?.focus();
}

function closeVideos() {
  if (!videosOpen) return;
  videosOpen = false;
  videosSeq += 1;
  $('videosPanel').hidden = true;
  $('videos').setAttribute('aria-expanded', 'false');
  requestOverlay('videos', 0);
}

// Another tab or page closes the video panel, as it does the shield's.
function followVideos(before, after) {
  if (videosOpen && (!after || before?.id !== after.id || before?.url !== after.url)) closeVideos();
}

$('downloads').addEventListener('click', openDownloads);
$('downloadsAll').addEventListener('click', () => {
  closeDownloads();
  api.downloads.openPage();
});
$('videos').addEventListener('click', openVideos);
for (const [panel, close, anchor] of [['downloadsPanel', closeDownloads, 'downloads'], ['videosPanel', closeVideos, 'videos']]) {
  $(panel).addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    close();
    $(anchor).focus();
  });
}
document.addEventListener('mousedown', (event) => {
  if (downloadsOpen && !$('downloadsPanel').contains(event.target) && !$('downloads').contains(event.target)) closeDownloads();
  if (videosOpen && !$('videosPanel').contains(event.target) && !$('videos').contains(event.target)) closeVideos();
});
api.onDownloadsBrief(showDownloadsBrief);
api.downloads.brief().then(showDownloadsBrief);
