'use strict';

const params = new URLSearchParams(location.search);
try {
  document.getElementById('host').textContent = new URL(params.get('url')).host;
} catch {
  // Keep the generic wording when the address cannot be parsed.
}
document.getElementById('code').textContent = `Error code: ${params.get('code') ?? 'unknown'}`;
document.getElementById('back').addEventListener('click', () => history.back());
