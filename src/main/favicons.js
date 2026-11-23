'use strict';

const { isAllowedUrl } = require('./security/navigation');

const MAX_ICON_BYTES = 256 * 1024;
const TIMEOUT_MS = 10_000;

// The image type, from the file's first bytes rather than what the server says (servers often
// send icons as application/octet-stream). SVG has no signature, so it needs the server's type.
function imageType(bytes, declaredType) {
  const starts = (...values) => values.every((value, i) => bytes[i] === value);
  if (starts(0x89, 0x50, 0x4E, 0x47)) return 'image/png';
  if (starts(0x00, 0x00, 0x01, 0x00)) return 'image/x-icon';
  if (starts(0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (starts(0xFF, 0xD8, 0xFF)) return 'image/jpeg';
  if (bytes.length > 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (declaredType === 'image/svg+xml') return 'image/svg+xml';
  return '';
}

// Reads at most `maxBytes` of the body; null if it is larger.
async function readLimited(response, maxBytes) {
  if (Number(response.headers.get('content-length')) > maxBytes) return null;
  if (!response.body) return Buffer.from(await response.arrayBuffer());
  const reader = response.body.getReader();
  const parts = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      reader.cancel().catch(() => {});
      return null;
    }
    parts.push(Buffer.from(value));
  }
  return Buffer.concat(parts);
}

// Fetches a page's icon through the tab's own session, so a private tab's request stays in its
// private session, and returns it as a data: URL. The browser's toolbar then shows icons without
// any network access of its own. Returns '' for anything that is not a small image.
async function fetchFavicon(session, url, { maxBytes = MAX_ICON_BYTES, timeoutMs = TIMEOUT_MS } = {}) {
  if (!isAllowedUrl(url)) return '';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await session.fetch(url, { signal: controller.signal });
    if (!response.ok) return '';
    const bytes = await readLimited(response, maxBytes);
    if (!bytes || bytes.length === 0) return '';
    const declared = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    const type = imageType(bytes, declared);
    return type ? `data:${type};base64,${bytes.toString('base64')}` : '';
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fetchFavicon, imageType, MAX_ICON_BYTES };
