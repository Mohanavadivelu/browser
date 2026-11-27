'use strict';

// ---------- Clear browsing data (Settings › Privacy) ----------
// Loaded before library.js and called from it. A time range, and what to clear over it, each
// with what it would remove (asked of the main process when the range changes). Bookmarks,
// settings and recordings are never cleared here; private tabs keep nothing to clear.
const CLEAR_RANGE_NAMES = { hour: 'the last hour', day: 'the last 24 hours', week: 'the last 7 days', month: 'the last 4 weeks', all: 'all time' };
let clearSeq = 0;

function clearChoices() {
  return {
    history: $('clearHistory').checked,
    cookies: $('clearCookies').checked,
    cache: $('clearCache').checked,
    downloads: $('clearDownloads').checked,
  };
}

const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

async function updateClearSummary() {
  const seq = ++clearSeq;
  const range = $('clearRange').value;
  const summary = await api.privacy.summary(range);
  if (seq !== clearSeq) return;
  $('clearHistoryNote').textContent = summary.history ? `${plural(summary.history, 'page')} in this time` : 'Nothing in this time';
  $('clearCookiesNote').textContent = summary.cookies
    ? `${plural(summary.cookies, 'cookie')} from ${plural(summary.cookieSites, 'site')}, and what those sites stored. Signs you out of them.`
    : range === 'all' ? 'No cookies. Anything sites stored is cleared too.' : 'No cookies were set in this time.';
  $('clearCacheNote').textContent = `Frees ${formatBytes(summary.cacheBytes) || '0 B'}. The cache can only be emptied whole, whatever the time.`;
  $('clearDownloadsNote').textContent = summary.downloads
    ? `${plural(summary.downloads, 'finished download')}. Only the list: the files stay where they are.`
    : 'No finished downloads in this time.';
  updateClearButton();
}

function updateClearButton() {
  $('clearConfirm').disabled = !Object.values(clearChoices()).some(Boolean);
}

async function openClearData() {
  $('clearDataMessage').hidden = true;
  $('clearRange').value = 'day';
  $('clearDialog').showModal();
  await updateClearSummary();
  $('clearRange').focus();
}

async function confirmClearData() {
  const range = $('clearRange').value;
  const what = clearChoices();
  $('clearConfirm').disabled = true;
  const done = await api.privacy.clear(range, what);
  $('clearDialog').close();
  const parts = [];
  if (what.history) parts.push(`${plural(done.history, 'page')} of history`);
  if (what.cookies) parts.push(done.cookies ? `${plural(done.cookies, 'cookie')} from ${plural(done.cookieSites, 'site')}` : range === 'all' ? 'all site data' : 'no cookies');
  if (what.cache) parts.push(`${formatBytes(done.cacheBytes) || '0 B'} of cache`);
  if (what.downloads) parts.push(`${plural(done.downloads, 'download')} from the list`);
  $('clearDataMessage').textContent = `Cleared from ${CLEAR_RANGE_NAMES[range]}: ${parts.join(', ')}.`;
  $('clearDataMessage').hidden = false;
}

function bindClearData() {
  $('clearDataOpen').addEventListener('click', openClearData);
  $('clearRange').addEventListener('change', updateClearSummary);
  for (const id of ['clearHistory', 'clearCookies', 'clearCache', 'clearDownloads']) $(id).addEventListener('change', updateClearButton);
  $('clearCancel').addEventListener('click', () => $('clearDialog').close());
  $('clearConfirm').addEventListener('click', confirmClearData);
}
