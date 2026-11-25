'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  appUrl, isAppUrl, resolveAppFile, serveAppFile, WEB_FILES, APP_SCHEME_PRIVILEGES,
} = require('../../src/main/app-scheme');

const RENDERER = path.join(__dirname, '..', '..', 'src', 'renderer');

test('app page addresses carry a query and a hash', () => {
  assert.equal(appUrl('index.html'), 'app://browser/index.html');
  assert.equal(appUrl('newtab.html', { query: { engine: 'bing' } }), 'app://browser/newtab.html?engine=bing');
  assert.equal(appUrl('library.html', { hash: 'bookmarks' }), 'app://browser/library.html#bookmarks');
  assert.equal(isAppUrl('app://browser/library.html#history'), true);
  assert.equal(isAppUrl('app://other/library.html'), false);
  assert.equal(isAppUrl('file:///C:/app/index.html'), false);
  assert.equal(isAppUrl('https://browser/'), false);
});

test('only plain file names of known types in the renderer folder are served', () => {
  assert.equal(resolveAppFile(RENDERER, 'app://browser/index.html'), path.join(RENDERER, 'index.html'));
  assert.equal(resolveAppFile(RENDERER, 'app://browser/library.html?x=1#bookmarks'), path.join(RENDERER, 'library.html'));
  for (const url of [
    'app://browser/../main/app.js',
    'app://browser/%2e%2e%2fmain%2fapp.js',
    'app://browser/..%5cmain%5capp.js',
    'app://browser/sub/index.html',
    'app://browser/C:%5cWindows%5cwin.ini',
    'app://browser/.hidden.js',
    'app://browser/notes.txt',
    'app://browser/%E0%A4%A.html',
    'app://other/index.html',
    'sb-media://recordings/x.webm',
    'not a url',
  ]) {
    assert.equal(resolveAppFile(RENDERER, url), null, url);
  }
});

test('web sessions get only the new tab page, the certificate warning and their files', () => {
  assert.equal(resolveAppFile(RENDERER, 'app://browser/newtab.html', WEB_FILES), path.join(RENDERER, 'newtab.html'));
  assert.equal(resolveAppFile(RENDERER, 'app://browser/pages.css', WEB_FILES), path.join(RENDERER, 'pages.css'));
  for (const name of ['index.html', 'library.html', 'library.js', 'app.js', 'indicator.html', 'find.html']) {
    assert.equal(resolveAppFile(RENDERER, `app://browser/${name}`, WEB_FILES), null, name);
  }
  // Every file a web page may load exists.
  for (const name of WEB_FILES) assert.ok(fs.existsSync(path.join(RENDERER, name)), name);
});

test('served files carry their type and cannot be sniffed; missing files are 404', async () => {
  const page = await serveAppFile(RENDERER, 'app://browser/index.html');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /^text\/html/);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.match(await page.text(), /Content-Security-Policy/);

  const script = await serveAppFile(RENDERER, 'app://browser/app.js');
  assert.match(script.headers.get('content-type'), /^text\/javascript/);

  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-scheme-'));
  assert.equal((await serveAppFile(folder, 'app://browser/missing.html')).status, 404);
  assert.equal((await serveAppFile(RENDERER, 'app://browser/../main/app.js')).status, 404);
  assert.equal((await serveAppFile(RENDERER, 'app://browser/library.html', WEB_FILES)).status, 404);
});

test('the scheme is a standard, secure origin (CSP self, screen capture)', () => {
  assert.equal(APP_SCHEME_PRIVILEGES.scheme, 'app');
  assert.equal(APP_SCHEME_PRIVILEGES.privileges.standard, true);
  assert.equal(APP_SCHEME_PRIVILEGES.privileges.secure, true);
});

test('every page the app loads, and every file those pages use, can be served', () => {
  for (const name of fs.readdirSync(RENDERER).filter((file) => file.endsWith('.html'))) {
    assert.ok(resolveAppFile(RENDERER, `app://browser/${name}`), name);
    const html = fs.readFileSync(path.join(RENDERER, name), 'utf8');
    for (const [, ref] of html.matchAll(/(?:src|href)="([^"#:]+)"/g)) {
      assert.ok(resolveAppFile(RENDERER, `app://browser/${ref}`), `${name} uses ${ref}`);
      assert.ok(fs.existsSync(path.join(RENDERER, ref)), `${name} uses ${ref}`);
    }
  }
});
