'use strict';

// ---------- The shield and its panel ----------
// The shield in the address bar counts the ads and trackers blocked on this page. A click opens
// a panel listing them by the host they went to (Ad or Tracker, by the list that caught them),
// with a switch that turns blocking off or on again for the site, and a link to the allowed
// sites in Settings. Esc or a click elsewhere closes it.
let shieldOpen = false;
let shieldSeq = 0;
let shieldTimer;
const openHosts = new Set();

function shieldIcon() {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', 'M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z');
  svg.append(path);
  return svg;
}

function siteOf(tab) {
  try {
    return tab && /^https?:/.test(tab.url) ? new URL(tab.url).hostname : '';
  } catch {
    return '';
  }
}

function renderShield(tab) {
  const shield = $('shield');
  const blocker = state.blocker;
  const site = siteOf(tab);
  shield.hidden = !site || !blocker?.enabled;
  if (shield.hidden) {
    if (shieldOpen) closeShield();
    return;
  }
  const allowed = blocker.allowedSites.includes(site);
  shield.classList.toggle('off', allowed);
  shield.replaceChildren(shieldIcon(), element('span', 'count', allowed ? 'off' : String(tab.blocked)));
  shield.setAttribute('aria-expanded', String(shieldOpen));
  shield.setAttribute('aria-haspopup', 'dialog');
  if (allowed) shield.title = `Ads and trackers are allowed on ${site}. Click for details.`;
  else if (!blocker.ready) shield.title = 'The ad and tracker lists are still downloading.';
  else shield.title = `${tab.blocked} ads and trackers blocked on this page. Click for details.`;
  shield.setAttribute('aria-label', shield.title);
}

function timeAgo(time) {
  const minutes = Math.max(0, Math.round((Date.now() - time) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function shieldHostRow(entry) {
  const item = element('li');
  const open = openHosts.has(entry.host);
  item.classList.toggle('open', open);
  const row = element('button', 'shield-host');
  row.type = 'button';
  row.setAttribute('aria-expanded', String(open));
  const tag = element('span', `tag ${entry.kind}`, entry.kind === 'tracker' ? 'Tracker' : 'Ad');
  row.append(element('span', 'arrow', open ? '▼' : '▶'), element('span', 'host', entry.host), tag, element('span', 'count', String(entry.count)));
  row.addEventListener('click', () => {
    if (openHosts.has(entry.host)) openHosts.delete(entry.host);
    else openHosts.add(entry.host);
    refreshShield();
  });
  item.append(row);
  if (open) {
    const list = element('div', 'shield-addresses');
    for (const address of entry.addresses) {
      const line = element('span', undefined, `${address.path} · ${address.type}`);
      line.title = `${entry.host}${address.path}`;
      list.append(line);
    }
    const more = entry.count - entry.addresses.length;
    if (more > 0) list.append(element('span', 'more', `and ${more} more`));
    item.append(list);
  }
  return item;
}

function drawShield(details) {
  const panel = $('shieldPanel');
  const { site, allowed, ready, total, hosts } = details;
  panel.classList.toggle('off', allowed);
  $('shieldTitle').textContent = allowed ? `Blocking is off on ${site}` : `${total} blocked on ${site}`;
  $('shieldNote').textContent = allowed
    ? 'Ads and trackers load on this site. Turn the switch on to block them again.'
    : !ready ? 'The ad and tracker lists are still downloading.'
      : total === 0 ? 'Nothing was blocked on this page.'
        : 'Ads and trackers this page asked for. The page itself is never blocked.';
  $('shieldSwitch').checked = !allowed;
  $('shieldSwitch').setAttribute('aria-label', `Block ads and trackers on ${site}`);
  $('shieldCols').hidden = hosts.length === 0;
  $('shieldHosts').replaceChildren(...hosts.map(shieldHostRow));
  $('shieldLists').textContent = `EasyList and EasyPrivacy${details.updatedAt ? ` · updated ${timeAgo(details.updatedAt)}` : ''}`;

  // Right edge under the shield's, never off the window's left edge.
  const shield = $('shield').getBoundingClientRect();
  panel.style.top = `${Math.round(shield.bottom + 10)}px`;
  panel.style.left = `${Math.max(8, Math.round(shield.right + 12 - panel.offsetWidth))}px`;
  requestOverlay('shield', panel.getBoundingClientRect().bottom + 12 - chromeHeight());
}

// Asks the main process for the active tab's list and draws it; a newer request wins.
async function refreshShield() {
  clearTimeout(shieldTimer);
  const seq = ++shieldSeq;
  const details = await api.blocker.details();
  if (!shieldOpen || seq !== shieldSeq) return;
  if (!details) {
    closeShield();
    return;
  }
  $('shieldPanel').hidden = false;
  drawShield(details);
}

async function openShield() {
  if (shieldOpen) {
    closeShield();
    return;
  }
  if (starBookmark) await closeStar(true);
  shieldOpen = true;
  openHosts.clear();
  $('shield').setAttribute('aria-expanded', 'true');
  await refreshShield();
  if (shieldOpen) $('shieldSwitch').focus();
}

function closeShield() {
  if (!shieldOpen) return;
  shieldOpen = false;
  shieldSeq += 1; // drop answers still on their way
  clearTimeout(shieldTimer);
  $('shieldPanel').hidden = true;
  $('shield').setAttribute('aria-expanded', 'false');
  requestOverlay('shield', 0);
}

// Called with the active tab before and after each state from the main process: another tab
// or page closes the panel; more blocked requests (or the switch) redraw it.
function followShield(before, after) {
  if (!shieldOpen) return;
  if (!after || before?.id !== after.id || before?.url !== after.url) {
    closeShield();
    return;
  }
  clearTimeout(shieldTimer);
  shieldTimer = setTimeout(refreshShield, 150);
}

$('shield').addEventListener('click', openShield);
$('shieldSwitch').addEventListener('change', async () => {
  await api.blocker.toggleSite();
  refreshShield();
});
$('shieldAllowed').addEventListener('click', () => {
  closeShield();
  api.blocker.openSettings();
});
$('shieldPanel').addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  closeShield();
  $('shield').focus();
});
document.addEventListener('mousedown', (event) => {
  if (shieldOpen && !$('shieldPanel').contains(event.target) && !$('shield').contains(event.target)) closeShield();
});
