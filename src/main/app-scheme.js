'use strict';

const fs = require('node:fs');
const path = require('node:path');

// The browser's own pages are served as app://browser/<file> instead of file:// URLs, so the
// packaged app can turn off the extra privileges Electron gives file:// pages (the
// GrantFileProtocolExtraPrivileges fuse). Only plain file names in the renderer folder are
// served; web sessions get only the pages a web tab can show (new tab and certificate warning).
const APP_SCHEME = 'app';
const APP_HOST = 'browser';
const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

const CONTENT_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
});
const PLAIN_NAME = /^[a-z0-9][a-z0-9-]*\.[a-z]+$/i;

// What a web tab may load: the new tab page, the certificate warning and what they use.
const WEB_FILES = Object.freeze(new Set(['newtab.html', 'newtab.js', 'warning.html', 'warning.js', 'pages.css']));

// app://browser/newtab.html?engine=google, from a file name and an optional query and hash.
function appUrl(file, { query, hash } = {}) {
  const url = new URL(`${APP_ORIGIN}/${file}`);
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, String(value));
  if (hash) url.hash = hash;
  return url.href;
}

function isAppUrl(url) {
  return typeof url === 'string' && url.startsWith(`${APP_ORIGIN}/`);
}

// The file a request asks for, or null: a plain name in `dir` with a known type, and one of
// `allowed` when that is given.
function resolveAppFile(dir, url, allowed) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${APP_SCHEME}:` || parsed.host !== APP_HOST) return null;
  let name;
  try {
    name = decodeURIComponent(parsed.pathname.slice(1));
  } catch {
    return null;
  }
  if (!PLAIN_NAME.test(name) || !Object.hasOwn(CONTENT_TYPES, path.extname(name).toLowerCase())) return null;
  if (allowed && !allowed.has(name)) return null;
  return path.join(dir, name);
}

async function serveAppFile(dir, url, allowed) {
  const file = resolveAppFile(dir, url, allowed);
  if (!file) return new Response('Not found', { status: 404 });
  try {
    const body = await fs.promises.readFile(file);
    return new Response(body, {
      headers: {
        'content-type': CONTENT_TYPES[path.extname(file).toLowerCase()],
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store',
      },
    });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

// Serves the scheme in one session; `allowed` limits it to some files (web sessions).
function serveAppPages(session, dir, allowed) {
  // A second start in the same process (tests do this) replaces the handler.
  if (session.protocol.isProtocolHandled(APP_SCHEME)) session.protocol.unhandle(APP_SCHEME);
  session.protocol.handle(APP_SCHEME, (request) => serveAppFile(dir, request.url, allowed));
}

// Privileges for registerSchemesAsPrivileged: a standard, secure origin like a website's, so
// 'self' in the pages' CSP works and the toolbar may capture the tab (a secure context).
const APP_SCHEME_PRIVILEGES = Object.freeze({
  scheme: APP_SCHEME,
  privileges: { standard: true, secure: true, codeCache: true },
});

module.exports = {
  APP_SCHEME, APP_ORIGIN, APP_SCHEME_PRIVILEGES, WEB_FILES, CONTENT_TYPES,
  appUrl, isAppUrl, resolveAppFile, serveAppFile, serveAppPages,
};
