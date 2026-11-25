'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { BookmarkIcons, MAX_ICON_LENGTH } = require('../../src/main/bookmark-icons');

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
const temp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-icons-')), 'bookmark-icons.json');

test('small image icons are kept by address and saved', () => {
  const file = temp();
  const icons = new BookmarkIcons(file);
  assert.equal(icons.set('https://a.example/', PNG), true);
  assert.equal(icons.set('https://a.example/', PNG), false, 'the same icon again changes nothing');
  assert.equal(icons.version, 1);
  assert.equal(icons.set('file:///C:/x', PNG), false);
  assert.equal(icons.set('https://b.example/', 'data:text/html;base64,PHNjcmlwdD4='), false, 'not an image');
  assert.equal(icons.set('https://b.example/', 'javascript:alert(1)'), false);
  assert.equal(icons.set('https://b.example/', `data:image/png;base64,${'A'.repeat(MAX_ICON_LENGTH)}`), false, 'too large');
  assert.deepEqual(icons.pick(['https://a.example/', 'https://none.example/']), { 'https://a.example/': PNG });
  icons.flush();
  const again = new BookmarkIcons(file);
  again.load();
  assert.equal(again.get('https://a.example/'), PNG);
});

test('icons of addresses no longer bookmarked are dropped, and bad files are ignored', () => {
  const file = temp();
  fs.writeFileSync(file, JSON.stringify({ 'https://a.example/': PNG, 'https://b.example/': PNG, 'javascript:x': PNG, 'https://c.example/': 'nope' }));
  const icons = new BookmarkIcons(file);
  icons.load();
  assert.deepEqual([...icons.icons.keys()], ['https://a.example/', 'https://b.example/']);
  assert.equal(icons.keepOnly(['https://b.example/']), true);
  assert.deepEqual([...icons.icons.keys()], ['https://b.example/']);
  assert.equal(icons.keepOnly(['https://b.example/']), false);
  fs.writeFileSync(file, 'not json');
  icons.load();
  assert.equal(icons.icons.size, 0);
});
