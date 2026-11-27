'use strict';

// What the site info panel (the lock in the address bar) shows about the page in a tab: whether
// its connection is secure and the certificate it presented, what it asked for and whether it
// got it, the cookies and data it keeps, and a way to clear those for that site only.

// What the permissions are called in the panel. Web pages only ever get full screen and writing
// to the clipboard (see security/permissions.js); anything else they ask for is refused.
const PERMISSION_NAMES = Object.freeze({
  geolocation: 'Your location',
  notifications: 'Notifications',
  media: 'Camera or microphone',
  fullscreen: 'Full screen',
  'clipboard-sanitized-write': 'Copy to the clipboard',
  'clipboard-read': 'Read the clipboard',
  midi: 'MIDI devices',
  midiSysex: 'MIDI devices',
  pointerLock: 'Hide the pointer',
  keyboardLock: 'Capture the keyboard',
  openExternal: 'Open another app',
  'idle-detection': 'Know when you are away',
  'window-management': 'Manage your windows',
  'speaker-selection': 'Choose your speakers',
  'storage-access': 'Use its cookies on other sites',
  'top-level-storage-access': 'Use its cookies on other sites',
  hid: 'HID devices',
  serial: 'Serial ports',
  usb: 'USB devices',
});
const MAX_PERMISSIONS = 20;
const MAX_HOSTS = 500;
const STORAGE_WORLD = 1208; // an isolated world for reading the page's storage use
const SITE_STORAGE = Object.freeze(['localStorage', 'indexedDB', 'serviceWorkers', 'fileSystems', 'webSQL', 'backgroundFetch']);

const permissionName = (permission) => PERMISSION_NAMES[permission] ?? String(permission).slice(0, 60);

// What each tab's page asked for, and whether it got it; cleared when the tab loads a new page.
class PermissionLog {
  constructor() {
    this.byContents = new Map();
  }

  record(contentsId, permission, granted) {
    let asked = this.byContents.get(contentsId);
    if (!asked) {
      asked = new Map();
      this.byContents.set(contentsId, asked);
    }
    const name = permissionName(permission);
    if (!asked.has(name) && asked.size >= MAX_PERMISSIONS) return;
    // Once allowed stays allowed in the list; a later refusal of the same thing doesn't hide it.
    asked.set(name, Boolean(granted) || asked.get(name) === true);
  }

  clear(contentsId) {
    this.byContents.delete(contentsId);
  }

  list(contentsId) {
    return [...(this.byContents.get(contentsId) ?? new Map())].map(([name, granted]) => ({ name, granted }));
  }
}

// The certificate each site presented last, by session and host name, kept as the browser checks
// it (Chromium still decides whether it is good). Only what the panel shows is kept.
class CertificateLog {
  constructor() {
    this.bySession = new WeakMap();
  }

  record(session, { hostname, certificate, verificationResult }) {
    if (!certificate || typeof hostname !== 'string') return;
    let hosts = this.bySession.get(session);
    if (!hosts) {
      hosts = new Map();
      this.bySession.set(session, hosts);
    }
    hosts.delete(hostname);
    hosts.set(hostname, {
      subject: String(certificate.subjectName ?? certificate.subject?.commonName ?? '').slice(0, 200),
      issuer: String(certificate.issuerName ?? certificate.issuer?.commonName ?? '').slice(0, 200),
      validUntil: Number(certificate.validExpiry) > 0 ? Number(certificate.validExpiry) * 1000 : 0,
      fingerprint: String(certificate.fingerprint ?? '').slice(0, 200),
      ok: verificationResult === 'net::OK',
    });
    while (hosts.size > MAX_HOSTS) hosts.delete(hosts.keys().next().value);
  }

  get(session, hostname) {
    return this.bySession.get(session)?.get(hostname) ?? null;
  }
}

// Whether a cookie set for `domain` is sent to `host`: the same host, or a site it belongs to
// (".example.com" goes to docs.example.com too).
function cookieMatches(domain, host) {
  const bare = String(domain ?? '').replace(/^\./, '').toLowerCase();
  const name = String(host ?? '').toLowerCase();
  return Boolean(bare) && (name === bare || name.endsWith(`.${bare}`));
}

const cookieUrl = (cookie) => `${cookie.secure ? 'https' : 'http'}://${String(cookie.domain).replace(/^\./, '')}${cookie.path || '/'}`;

async function siteCookies(session, host) {
  return (await session.cookies.get({})).filter((cookie) => cookieMatches(cookie.domain, host));
}

// How much the page's origin keeps (local storage, databases, caches it made), as the page itself
// would see it; read in a world of its own, so the page can't change the answer.
async function storageUsage(contents) {
  try {
    const usage = await contents.executeJavaScriptInIsolatedWorld(STORAGE_WORLD, [{
      code: 'navigator.storage && navigator.storage.estimate ? navigator.storage.estimate().then((e) => e.usage || 0) : 0',
    }]);
    return Number.isFinite(usage) && usage >= 0 ? Math.min(usage, 1e13) : 0;
  } catch {
    return 0;
  }
}

// The same site under the other scheme, for clearing both.
function bothOrigins(url) {
  const { protocol, host } = new URL(url);
  const other = protocol === 'https:' ? 'http:' : 'https:';
  return [`${protocol}//${host}`, `${other}//${host}`];
}

// Removes the site's cookies (those sent to its host) and everything it stored, for this site
// only and in this tab's own session.
async function clearSiteData(session, url) {
  const { hostname } = new URL(url);
  const cookies = await siteCookies(session, hostname);
  for (const cookie of cookies) {
    await session.cookies.remove(cookieUrl(cookie), cookie.name).catch(() => {});
  }
  await session.clearData({ origins: bothOrigins(url), dataTypes: [...SITE_STORAGE] });
  return { cookies: cookies.length };
}

module.exports = {
  PermissionLog, CertificateLog, cookieMatches, cookieUrl, siteCookies, storageUsage, clearSiteData, bothOrigins, permissionName, SITE_STORAGE,
};
