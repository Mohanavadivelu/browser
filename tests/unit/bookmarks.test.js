'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const bookmarks = require('../../src/main/bookmarks');
const { resolveInput } = require('../../src/main/security/navigation');

const list = [
  { url: 'https://a.example/', title: 'Alpha' },
  { url: 'https://b.example/', title: 'Beta' },
  { url: 'https://c.example/', title: 'Gamma' },
];

test('bookmarks can be renamed, removed and moved without changing the original list', () => {
  assert.deepEqual(bookmarks.rename(list, 'https://b.example/', '  New   name ')[1], { url: 'https://b.example/', title: 'New name' });
  assert.equal(bookmarks.rename(list, 'https://b.example/', '   ')[1].title, 'https://b.example/');
  assert.equal(bookmarks.rename(list, 'https://b.example/', 'x'.repeat(500))[1].title.length, 200);
  assert.equal(bookmarks.rename(list, 'https://missing.example/', 'x'), null);

  assert.deepEqual(bookmarks.remove(list, 'https://a.example/').map((b) => b.title), ['Beta', 'Gamma']);
  assert.equal(bookmarks.remove(list, 'https://missing.example/'), null);

  assert.deepEqual(bookmarks.move(list, 'https://c.example/', 0).map((b) => b.title), ['Gamma', 'Alpha', 'Beta']);
  assert.deepEqual(bookmarks.move(list, 'https://a.example/', 99).map((b) => b.title), ['Beta', 'Gamma', 'Alpha']);
  assert.equal(bookmarks.move(list, 'https://missing.example/', 0), null);
  assert.deepEqual(list.map((b) => b.title), ['Alpha', 'Beta', 'Gamma']);
});

test('export writes a bookmarks file that reads back the same', () => {
  const tricky = [{ url: 'https://x.example/?a=1&b="2"', title: 'Tom & Jerry <3' }, ...list];
  const html = bookmarks.toHtml(tricky);
  assert.match(html, /^<!DOCTYPE NETSCAPE-Bookmark-file-1>/);
  assert.match(html, /Tom &amp; Jerry &lt;3/);
  assert.doesNotMatch(html, /<3/);
  assert.deepEqual(bookmarks.fromHtml(html), tricky);
});

test('import reads a Chrome or Firefox file: folders flattened, unsafe links dropped', () => {
  const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
  <DT><H3 ADD_DATE="1">Bookmarks bar</H3>
  <DL><p>
    <DT><A HREF="https://news.example/" ADD_DATE="1" ICON="data:image/png;base64,AAA">News &#8211; daily</A>
    <DT><H3>Work</H3>
    <DL><p>
      <DT><a href='https://work.example/wiki'>Wiki <b>home</b></a>
    </DL><p>
  </DL><p>
  <DT><A HREF="javascript:alert(1)">Bookmarklet</A>
  <DT><A HREF="place:sort=8">Firefox query</A>
  <DT><A HREF="file:///C:/secret.txt">Local file</A>
  <DT><A HREF="http://old.example/">&lt;Old&gt; &amp; plain</A>
</DL><p>`;
  assert.deepEqual(bookmarks.fromHtml(html), [
    { url: 'https://news.example/', title: 'News – daily' },
    { url: 'https://work.example/wiki', title: 'Wiki home' },
    { url: 'http://old.example/', title: '<Old> & plain' },
  ]);
  assert.deepEqual(bookmarks.fromHtml('not a bookmarks file'), []);
});

test('importing adds new bookmarks after the existing ones, skipping duplicates and stopping at the limit', () => {
  const imported = [{ url: 'https://b.example/', title: 'Beta again' }, { url: 'https://d.example/', title: 'Delta' }, { url: 'https://e.example/', title: 'Epsilon' }];
  const merged = bookmarks.merge(list, imported, 4);
  assert.deepEqual(merged.list.map((b) => b.title), ['Alpha', 'Beta', 'Gamma', 'Delta']);
  assert.equal(merged.added, 1);
  assert.equal(merged.skipped, 2);
});

test('simple-browser://bookmarks is a browser page', () => {
  assert.deepEqual(resolveInput('simple-browser://bookmarks'), { ok: true, internal: 'bookmarks' });
});
