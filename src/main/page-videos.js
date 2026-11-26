'use strict';

const { isAllowedUrl } = require('./security/navigation');

// A world of its own for the scan, apart from the page's scripts (which cannot change what it
// reads or see that it ran). Its number only has to differ from Electron's main world (0).
const SCAN_WORLD = 1207;
const MAX_VIDEOS = 20;
const SCAN_DELAY_MS = 400;
const SCAN_CODE = `(() => {
  const found = [];
  for (const video of Array.from(document.querySelectorAll('video')).slice(0, ${MAX_VIDEOS})) {
    const source = video.querySelector('source[src]');
    found.push({
      src: String(video.currentSrc || video.src || (source ? source.src : '')).slice(0, 2048),
      width: video.videoWidth | 0,
      height: video.videoHeight | 0,
      duration: Number.isFinite(video.duration) ? video.duration : 0,
      protected: Boolean(video.mediaKeys),
      title: String(video.title || video.getAttribute('aria-label') || '').slice(0, 200),
    });
  }
  return found;
})()`;

function nameFromUrl(url) {
  try {
    const last = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() ?? '');
    return last.slice(0, 200) || 'video';
  } catch {
    return 'video';
  }
}

// What the scan found, checked: a plain file at an http(s) address can be saved; a video
// played from pieces (a blob: address, as streaming sites use) or one the site protects
// (encrypted media) cannot, and the panel says why. Anything else is left out.
function classifyVideos(raw) {
  if (!Array.isArray(raw)) return [];
  const videos = [];
  const seen = new Set();
  for (const video of raw.slice(0, MAX_VIDEOS)) {
    if (video === null || typeof video !== 'object' || typeof video.src !== 'string') continue;
    const src = video.src;
    const kind = video.protected === true ? 'protected' : src.startsWith('blob:') ? 'streamed' : isAllowedUrl(src) ? 'file' : null;
    if (!kind || (kind === 'file' && seen.has(src))) continue;
    if (kind === 'file') seen.add(src);
    const number = (value, max) => (Number.isFinite(value) && value > 0 && value < max ? Math.round(value) : 0);
    videos.push({
      kind,
      url: kind === 'file' ? src : '',
      name: kind === 'file' ? nameFromUrl(src) : '',
      title: typeof video.title === 'string' ? video.title.slice(0, 200) : '',
      width: number(video.width, 100_000),
      height: number(video.height, 100_000),
      duration: number(video.duration, 1_000_000),
    });
  }
  return videos;
}

// Keeps a list of the videos on each web tab's page, looked for when a page finishes loading or
// starts playing something. `onChange()` hears when a list changed.
class VideoFinder {
  constructor({ onChange = () => {} } = {}) {
    this.onChange = onChange;
    this.found = new Map(); // tab id -> videos
    this.timers = new Map();
  }

  watch(tab) {
    const contents = tab.view.webContents;
    const soon = () => this.schedule(tab);
    contents.on('did-stop-loading', soon);
    contents.on('media-started-playing', soon);
    contents.on('did-navigate', () => this.set(tab.id, []));
    contents.once('destroyed', () => {
      clearTimeout(this.timers.get(tab.id));
      this.timers.delete(tab.id);
      this.found.delete(tab.id);
    });
  }

  schedule(tab) {
    clearTimeout(this.timers.get(tab.id));
    const timer = setTimeout(() => {
      this.timers.delete(tab.id);
      this.scan(tab).catch(() => {});
    }, SCAN_DELAY_MS);
    timer.unref?.();
    this.timers.set(tab.id, timer);
  }

  async scan(tab) {
    const contents = tab.view.webContents;
    if (!contents || contents.isDestroyed()) return [];
    const raw = await contents.executeJavaScriptInIsolatedWorld(SCAN_WORLD, [{ code: SCAN_CODE }]);
    if (contents.isDestroyed()) return [];
    const videos = classifyVideos(raw);
    this.set(tab.id, videos);
    return videos;
  }

  set(tabId, videos) {
    const before = JSON.stringify(this.found.get(tabId) ?? []);
    this.found.set(tabId, videos);
    if (JSON.stringify(videos) !== before) this.onChange(tabId);
  }

  list(tabId) {
    return this.found.get(tabId) ?? [];
  }
}

module.exports = { VideoFinder, classifyVideos, nameFromUrl, SCAN_WORLD };
