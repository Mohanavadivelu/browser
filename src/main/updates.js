'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const FIRST_CHECK_MS = 30_000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

// "0.10.0" > "0.9.1"; a leading "v" is ignored. Pre-release labels are not used here.
function compareVersions(a, b) {
  const parts = (version) => String(version).replace(/^v/i, '').split('-')[0].split('.').map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0) ? 1 : -1;
  }
  return 0;
}

// How this copy can be updated:
// - 'installer': installed with the setup program, so electron-updater can download and install;
// - 'notify': the portable .exe or an unpacked folder, which cannot replace itself, so the user
//   is told about a new version and shown where to download it;
// - 'off': running from source.
function updateMode({ isPackaged, env = process.env, execPath = process.execPath, productName = 'Simple Browser', exists = fs.existsSync }) {
  if (!isPackaged) return 'off';
  if (env.PORTABLE_EXECUTABLE_DIR) return 'notify';
  return exists(path.join(path.dirname(execPath), `Uninstall ${productName}.exe`)) ? 'installer' : 'notify';
}

// Checks GitHub Releases for a newer version. `autoUpdater` is electron-updater's (installer
// mode); `fetchLatest()` returns { version, url } of the latest release (notify mode).
// Emits 'change' whenever `state` changes.
class UpdateService extends EventEmitter {
  constructor({ mode, currentVersion, autoUpdater, fetchLatest, notify, isEnabled = () => true }) {
    super();
    this.mode = mode;
    this.currentVersion = currentVersion;
    this.autoUpdater = autoUpdater;
    this.fetchLatest = fetchLatest;
    this.notify = notify;
    this.isEnabled = isEnabled;
    this.state = { status: 'idle', version: null, url: null, percent: null };
    this.timers = [];
    if (mode === 'installer') this.wireAutoUpdater();
  }

  set(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('change', this.state);
  }

  wireAutoUpdater() {
    const updater = this.autoUpdater;
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = true;
    updater.allowPrerelease = false;
    updater.logger = null;
    updater.on('update-available', (info) => {
      this.set({ status: 'downloading', version: info.version, percent: 0 });
      this.notify(`Downloading Simple Browser ${info.version}…`);
    });
    updater.on('download-progress', (progress) => this.set({ percent: Math.round(progress.percent) }));
    updater.on('update-not-available', () => {
      this.set({ status: 'up-to-date' });
      if (this.manual) this.notify('Simple Browser is up to date.');
    });
    updater.on('update-downloaded', (info) => {
      this.set({ status: 'ready', version: info.version, percent: 100 });
      this.notify(`Simple Browser ${info.version} is ready. It installs when you close the browser, or restart from the ⋮ menu.`);
    });
    updater.on('error', (error) => {
      this.set({ status: 'error' });
      if (this.manual) this.notify(`Could not check for updates: ${error.message}`, 'error');
    });
  }

  // `manual` is a check the user asked for: they also hear "up to date" and errors.
  async check({ manual = false } = {}) {
    if (this.mode === 'off') {
      if (manual) this.notify('Updates are not checked when running from source.', 'warning');
      return this.state;
    }
    if (!manual && !this.isEnabled()) return this.state;
    if (['checking', 'downloading', 'ready'].includes(this.state.status)) return this.state;
    this.manual = manual;
    this.set({ status: 'checking' });
    if (this.mode === 'installer') {
      try {
        await this.autoUpdater.checkForUpdates();
      } catch (error) {
        this.set({ status: 'error' });
        if (manual) this.notify(`Could not check for updates: ${error.message}`, 'error');
      }
      return this.state;
    }
    try {
      const latest = await this.fetchLatest();
      if (latest && compareVersions(latest.version, this.currentVersion) > 0) {
        this.set({ status: 'available', version: latest.version, url: latest.url });
        this.notify(`Simple Browser ${latest.version} is available. Download it from the ⋮ menu.`);
      } else {
        this.set({ status: 'up-to-date' });
        if (manual) this.notify('Simple Browser is up to date.');
      }
    } catch (error) {
      this.set({ status: 'error' });
      if (manual) this.notify(`Could not check for updates: ${error.message}`, 'error');
    }
    return this.state;
  }

  // Checks shortly after start, then every few hours, while the setting allows it.
  start() {
    if (this.mode === 'off') return;
    const first = setTimeout(() => this.check(), FIRST_CHECK_MS);
    const repeat = setInterval(() => this.check(), CHECK_EVERY_MS);
    first.unref?.();
    repeat.unref?.();
    this.timers.push(first, repeat);
  }

  stop() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
  }

  // Restarts into the downloaded version (installer), or returns the download page (notify).
  install() {
    if (this.mode === 'installer' && this.state.status === 'ready') {
      this.autoUpdater.quitAndInstall();
      return null;
    }
    return this.state.status === 'available' ? this.state.url : null;
  }
}

// The latest release on GitHub, as { version, url }.
async function fetchLatestRelease(fetch, { owner, repo }) {
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Simple-Browser-Update-Check' },
  });
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
  const release = await response.json();
  if (typeof release.tag_name !== 'string') throw new Error('unexpected answer from GitHub');
  const url = `https://github.com/${owner}/${repo}/releases/tag/${encodeURIComponent(release.tag_name)}`;
  return { version: release.tag_name.replace(/^v/i, ''), url };
}

module.exports = { UpdateService, compareVersions, updateMode, fetchLatestRelease };
