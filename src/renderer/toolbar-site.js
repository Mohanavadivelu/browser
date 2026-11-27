'use strict';

// ---------- The site info panel ----------
// The lock (or "Not secure") at the start of the address bar opens a panel about the page:
// whether its connection is secure and its certificate, what it asked for and whether it got it,
// the cookies and data it keeps (with Clear data, for this site only, after a confirmation in
// the main process), the ads and trackers blocked on it, and its zoom. Esc or a click elsewhere
// closes it; so does another tab or page.
let siteOpen = false;
let siteSeq = 0;

function svgIcon(paths, className) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  if (className) svg.setAttribute('class', className);
  for (const d of paths) {
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

const LOCK = ['M7 11h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2z', 'M8 11V8a4 4 0 0 1 8 0v3'];
const WARN = ['M12 4l9 16H3z', 'M12 10v4', 'M12 17v.01'];

function siteSize(bytes) {
  if (!(bytes > 0)) return '0 KB';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

// The button at the start of the address bar: a lock for https, "Not secure" for http, nothing
// for the browser's own pages.
function renderSecurity(tab) {
  const button = $('security');
  const url = tab?.url ?? '';
  const secure = url.startsWith('https:');
  const insecure = url.startsWith('http:');
  button.hidden = !(tab?.kind === 'web' && (secure || insecure) && !tab.crashed);
  if (button.hidden) {
    if (siteOpen) closeSite();
    return;
  }
  button.classList.toggle('warn', insecure);
  button.replaceChildren(svgIcon(secure ? LOCK : WARN));
  if (insecure) button.append(element('span', 'label', 'Not secure'));
  let site = '';
  try {
    site = new URL(url).host;
  } catch {
    site = '';
  }
  button.setAttribute('aria-label', `${insecure ? 'Not secure. ' : ''}Site info for ${site}`);
  button.title = `Site info for ${site}`;
  button.setAttribute('aria-expanded', String(siteOpen));
}

function siteRow(className, ...children) {
  const row = element('div', `site-row ${className ?? ''}`.trim());
  row.append(...children);
  return row;
}

function drawSite(info) {
  const panel = $('sitePanel');
  panel.replaceChildren();
  panel.classList.toggle('insecure', !info.secure);

  const head = element('header', 'site-head');
  const titles = element('div');
  const title = element('h2', undefined, info.site);
  title.id = 'siteTitle';
  const status = element('p', `site-status ${info.secure ? 'ok' : 'warn'}`);
  status.append(svgIcon(info.secure ? LOCK : WARN), info.secure ? 'Connection is secure' : 'Connection is not secure');
  titles.append(title, status);
  const close = element('button', 'site-close');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close');
  close.append(svgIcon(['M6 6l12 12', 'M18 6L6 18']));
  close.addEventListener('click', () => { closeSite(); $('security').focus(); });
  head.append(titles, close);
  panel.append(head);

  panel.append(element('p', 'site-about', info.secure
    ? `What you send and receive here is encrypted, and the site proved it is ${info.site}.`
    : 'This site uses plain http. Anyone on the same network (public Wi-Fi, for example) can see the pages you open here and what you type into them. Don\'t enter passwords or card numbers.'));

  if (info.secure) {
    const details = element('details', 'site-cert');
    details.append(element('summary', undefined, 'Certificate'));
    if (info.certificate) {
      const list = element('dl');
      const add = (term, value) => list.append(element('dt', undefined, term), element('dd', undefined, value));
      add('Issued to', info.certificate.subject || info.site);
      add('Issued by', info.certificate.issuer || 'Unknown');
      if (info.certificate.validUntil) add('Valid until', new Date(info.certificate.validUntil).toLocaleDateString());
      if (info.certificate.fingerprint) add('Fingerprint', info.certificate.fingerprint);
      details.append(list);
    } else {
      details.append(element('p', 'site-note', 'Its details show once the page has loaded over this connection.'));
    }
    panel.append(details);
  } else if (info.httpsUrl) {
    const box = element('div', 'site-https');
    const go = element('button', 'link', 'open the secure version');
    go.type = 'button';
    go.addEventListener('click', () => { closeSite(); api.nav.go(info.httpsUrl); });
    box.append('If the site also works over https, ', go, '.');
    panel.append(box);
  }

  const asked = element('section', 'site-section');
  asked.append(element('h3', undefined, 'What this site asked for'));
  if (info.permissions.length) {
    const list = element('ul', 'site-perms');
    for (const permission of info.permissions) {
      const item = element('li');
      item.append(element('span', undefined, permission.name), element('span', permission.granted ? 'yes' : 'no', permission.granted ? 'Allowed' : 'Blocked'));
      list.append(item);
    }
    asked.append(list);
  } else {
    asked.append(element('p', 'site-note', 'Nothing yet on this page.'));
  }
  asked.append(element('p', 'site-note', 'Simple Browser never gives websites your camera, microphone, location or notifications.'));
  panel.append(asked);

  const data = element('div');
  data.append(element('div', undefined, 'Cookies and site data'),
    element('div', 'site-note', `${info.cookies} cookie${info.cookies === 1 ? '' : 's'} · ${siteSize(info.storageBytes)} stored by this site`));
  const clear = element('button', 'danger', 'Clear data');
  clear.type = 'button';
  clear.id = 'siteClear';
  clear.addEventListener('click', async () => {
    clear.disabled = true;
    await api.site.clearData();
    if (siteOpen) refreshSite();
  });
  panel.append(siteRow('site-data', data, clear));

  if (state.blocker?.enabled) {
    const shield = element('div', 'site-grow', info.blocking
      ? `Ads and trackers blocked on this page: ${info.blocked}`
      : 'Ads and trackers: blocking is off on this site');
    const act = element('button', 'link', info.blocking ? 'Details' : 'Turn on');
    act.type = 'button';
    act.addEventListener('click', async () => {
      if (info.blocking) {
        closeSite();
        openShield();
      } else {
        await api.blocker.toggleSite();
        refreshSite();
      }
    });
    panel.append(siteRow('', shield, act));
  }

  if (info.zoom !== 100) {
    const reset = element('button', 'link', 'Reset zoom');
    reset.type = 'button';
    reset.addEventListener('click', async () => { await api.zoom.reset(); refreshSite(); });
    panel.append(siteRow('', element('div', 'site-grow site-note', `Zoom ${info.zoom}%`), reset));
  }
  if (info.isPrivate) panel.append(element('p', 'site-note site-private', 'Private tab: all of this is forgotten when the tab closes.'));

  const anchor = $('security').getBoundingClientRect();
  panel.style.top = `${Math.round(anchor.bottom + 10)}px`;
  panel.style.left = `${Math.max(8, Math.round(anchor.left - 6))}px`;
  requestOverlay('site', panel.getBoundingClientRect().bottom + 12 - chromeHeight());
}

async function refreshSite() {
  const seq = ++siteSeq;
  const info = await api.site.info();
  if (!siteOpen || seq !== siteSeq) return;
  if (!info) {
    closeSite();
    return;
  }
  $('sitePanel').hidden = false;
  drawSite(info);
}

async function openSite() {
  if (siteOpen) {
    closeSite();
    return;
  }
  if (starBookmark) await closeStar(true);
  closeShield();
  closeDownloads();
  closeVideos();
  closeTabSearch();
  siteOpen = true;
  $('security').setAttribute('aria-expanded', 'true');
  await refreshSite();
  if (siteOpen) $('sitePanel').querySelector('button')?.focus();
}

function closeSite() {
  if (!siteOpen) return;
  siteOpen = false;
  siteSeq += 1;
  $('sitePanel').hidden = true;
  $('security').setAttribute('aria-expanded', 'false');
  requestOverlay('site', 0);
}

// Another tab or page closes the panel.
function followSite(before, after) {
  if (siteOpen && (!after || before?.id !== after.id || before?.url !== after.url)) closeSite();
}

$('security').addEventListener('click', openSite);
$('sitePanel').addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  closeSite();
  $('security').focus();
});
document.addEventListener('mousedown', (event) => {
  if (siteOpen && !$('sitePanel').contains(event.target) && !$('security').contains(event.target)) closeSite();
});
