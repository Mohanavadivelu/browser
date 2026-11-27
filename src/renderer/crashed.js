'use strict';

// Shown in a tab whose page crashed. It has no bridge to the browser (it is web content); its
// buttons only change this page's own #hash, and the browser, seeing that on its crash page,
// reloads the page that crashed or closes the tab.
const REASONS = {
  oom: 'it ran out of memory',
  crashed: 'it stopped unexpectedly',
  'abnormal-exit': 'it stopped unexpectedly',
  killed: 'it was stopped by another program or by Windows',
  'launch-failed': 'it could not start',
  'integrity-failure': 'a security check on it failed',
  'memory-eviction': 'Windows needed the memory back',
};

const params = new URLSearchParams(location.search);
const reason = params.get('reason') ?? '';
try {
  document.getElementById('host').textContent = new URL(params.get('url')).host;
} catch {
  // Keep the generic wording when the address cannot be parsed.
}
document.getElementById('reason').textContent = REASONS[reason] ?? 'it stopped unexpectedly';
document.getElementById('code').textContent = reason || 'unknown';
document.getElementById('reload').addEventListener('click', () => { location.hash = 'reload'; });
document.getElementById('close').addEventListener('click', () => { location.hash = 'close'; });
document.getElementById('reload').focus();
