'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const bookmarks = require('../../src/main/bookmarks');
const { resolveInput } = require('../../src/main/security/navigation');
const { sanitizeSettings } = require('../../src/main/storage/settings');

// The tree as titles, for comparing shapes: folders as [title, [...children]].
const shape = (nodes) => nodes.map((node) => (node.type === 'folder' ? [node.title, shape(node.children)] : node.title));

function sample() {
  let tree = bookmarks.emptyTree();
  const add = (parent, title, url) => {
    const result = bookmarks.addLink(tree, parent, { url, title });
    tree = result.tree;
    return result.id;
  };
  const folder = (parent, title) => {
    const result = bookmarks.addFolder(tree, parent, title);
    tree = result.tree;
    return result.id;
  };
  const ids = {};
  ids.mail = add('bar', 'Mail', 'https://mail.example/');
  ids.work = folder('bar', 'Work');
  ids.board = add(ids.work, 'Board', 'https://board.example/');
  ids.projects = folder(ids.work, 'Projects');
  ids.spec = add(ids.projects, 'Spec', 'https://spec.example/');
  ids.news = add('other', 'News', 'https://news.example/');
  return { tree: () => tree, ids };
}

test('the flat list of earlier versions becomes the Bookmarks bar', () => {
  const settings = sanitizeSettings({ bookmarks: [{ url: 'https://a.example/', title: 'A' }, { url: 'javascript:alert(1)', title: 'bad' }, null, { url: 'http://b.example/' }] });
  assert.deepEqual(shape(settings.bookmarks.bar.children), ['A', 'http://b.example/']);
  assert.deepEqual(settings.bookmarks.other.children, []);
  assert.equal(settings.bookmarks.bar.title, 'Bookmarks bar');
  assert.equal(settings.bookmarkFolder, 'bar');
});

test('a stored tree is cleaned: bad links dropped, ids made unique, depth capped', () => {
  let deep = { type: 'folder', title: 'level', children: [] };
  for (let i = 0; i < 20; i += 1) deep = { type: 'folder', title: `level ${i}`, children: [deep] };
  const tree = bookmarks.sanitizeTree({
    bar: { children: [
      { id: 'same', type: 'link', url: 'https://a.example/', title: '  A   site ' },
      { id: 'same', type: 'link', url: 'https://b.example/', title: 'B' },
      { id: 'x', type: 'link', url: 'file:///C:/secret', title: 'nope' },
      { id: '../bad id', type: 'folder', title: '', children: [] },
      deep,
    ] },
    other: 'not a folder',
  });
  const [a, b, folder] = tree.bar.children;
  assert.deepEqual([a.title, b.title, folder.title], ['A site', 'B', 'Folder']);
  assert.equal(a.id, 'same');
  assert.notEqual(b.id, 'same');
  assert.match(folder.id, /^[A-Za-z0-9_-]+$/);
  let depth = 0;
  for (let node = tree.bar.children[3]; node; node = node.children?.[0]) depth += 1;
  assert.ok(depth < bookmarks.MAX_DEPTH, `depth ${depth}`);
  assert.deepEqual(tree.other.children, []);
});

test('links and folders can be added, renamed, moved and removed without changing the original', () => {
  const { tree, ids } = sample();
  const before = JSON.stringify(tree());
  assert.deepEqual(shape(tree().bar.children), ['Mail', ['Work', ['Board', ['Projects', ['Spec']]]]]);
  assert.deepEqual(bookmarks.links(tree()).map((link) => [link.title, link.folder]), [
    ['Mail', 'Bookmarks bar'], ['Board', 'Bookmarks bar › Work'], ['Spec', 'Bookmarks bar › Work › Projects'], ['News', 'Other bookmarks'],
  ]);

  const renamed = bookmarks.update(tree(), ids.board, { title: '  Team board ', url: 'https://board.example/team' });
  assert.deepEqual(bookmarks.find(renamed, ids.board).node, { id: ids.board, type: 'link', title: 'Team board', url: 'https://board.example/team' });
  assert.equal(bookmarks.update(tree(), ids.board, { url: 'javascript:alert(1)' }), null);
  assert.equal(bookmarks.update(tree(), ids.work, { url: 'https://x.example/' }), null, 'folders have no address');
  assert.equal(bookmarks.update(tree(), 'bar', { title: 'Mine' }), null, 'the two top folders keep their names');

  const moved = bookmarks.move(tree(), ids.news, ids.projects, 0);
  assert.deepEqual(shape(bookmarks.find(moved, ids.projects).node.children), ['News', 'Spec']);
  assert.equal(bookmarks.move(tree(), ids.work, ids.projects, 0), null, 'not into its own folder');
  assert.equal(bookmarks.move(tree(), ids.work, ids.work, 0), null);
  assert.equal(bookmarks.move(tree(), 'bar', 'other', 0), null);
  const reordered = bookmarks.move(tree(), ids.mail, 'bar', 1);
  assert.deepEqual(shape(reordered.bar.children), [['Work', ['Board', ['Projects', ['Spec']]]], 'Mail']);

  const removed = bookmarks.remove(tree(), [ids.work, ids.news, 'missing']);
  assert.deepEqual(shape(removed.bar.children), ['Mail']);
  assert.deepEqual(removed.other.children, []);
  assert.equal(bookmarks.remove(tree(), ['bar']), null);
  assert.equal(JSON.stringify(tree()), before);
});

test('folders are listed with their paths, and a link is found by its address', () => {
  const { tree, ids } = sample();
  assert.deepEqual(bookmarks.folders(tree()).map((folder) => folder.label), [
    'Bookmarks bar', 'Bookmarks bar › Work', 'Bookmarks bar › Work › Projects', 'Other bookmarks',
  ]);
  assert.equal(bookmarks.findLinkByUrl(tree(), 'https://spec.example/').id, ids.spec);
  assert.equal(bookmarks.findLinkByUrl(tree(), 'https://none.example/'), null);
  assert.equal(bookmarks.addLink(tree(), ids.mail, { url: 'https://x.example/' }), null, 'only into a folder');
  assert.equal(bookmarks.addLink(tree(), 'bar', { url: 'file:///x' }), null);
});

test('export keeps folders, and reads back the same', () => {
  const { tree } = sample();
  const html = bookmarks.toHtml(tree());
  assert.match(html, /^<!DOCTYPE NETSCAPE-Bookmark-file-1>/);
  assert.match(html, /<H3 PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar<\/H3>/);
  const back = bookmarks.fromHtml(html);
  assert.deepEqual(shape(back.bar), ['Mail', ['Work', ['Board', ['Projects', ['Spec']]]]]);
  assert.deepEqual(shape(back.other), [['Other bookmarks', ['News']]]);
  const tricky = bookmarks.addLink(bookmarks.emptyTree(), 'bar', { url: 'https://x.example/?a=1&b="2"', title: 'Tom & Jerry <3' }).tree;
  const again = bookmarks.fromHtml(bookmarks.toHtml(tricky));
  assert.deepEqual(again.bar.map((link) => [link.title, link.url]), [['Tom & Jerry <3', 'https://x.example/?a=1&b="2"']]);
});

test('a Chrome or Firefox file is imported with its folders and icons; unsafe links are dropped', () => {
  const icon = 'data:image/png;base64,iVBORw0KGgo=';
  const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
  <DT><H3 ADD_DATE="1" PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>
  <DL><p>
    <DT><A HREF="https://news.example/" ICON="${icon}">News &#8211; daily</A>
    <DT><H3>Work</H3>
    <DL><p>
      <DT><a href='https://work.example/wiki' icon="javascript:alert(1)">Wiki <b>home</b></a>
      <DT><A HREF="javascript:alert(1)">Bookmarklet</A>
    </DL><p>
  </DL><p>
  <DT><H3>Other bookmarks</H3>
  <DL><p>
    <DT><A HREF="http://old.example/">&lt;Old&gt; &amp; plain</A>
    <DT><A HREF="place:sort=8">Firefox query</A>
  </DL><p>
  <DT><A HREF="https://loose.example/">Loose</A>
</DL><p>`;
  const parsed = bookmarks.fromHtml(html);
  assert.deepEqual(shape(parsed.bar), ['News – daily', ['Work', ['Wiki home']]]);
  assert.deepEqual(shape(parsed.other), [['Other bookmarks', ['<Old> & plain']], 'Loose']);
  assert.deepEqual(parsed.icons, { 'https://news.example/': icon });
  assert.deepEqual(bookmarks.fromHtml('not a bookmarks file'), { bar: [], other: [], icons: {} });
});

test('importing adds folders and links after what is there, skipping addresses already bookmarked', () => {
  const { tree } = sample();
  const imported = {
    bar: [{ type: 'link', url: 'https://mail.example/', title: 'Mail again' }, { type: 'folder', title: 'Reading', children: [
      { type: 'link', url: 'https://blog.example/', title: 'Blog' },
    ] }, { type: 'folder', title: 'Only known', children: [{ type: 'link', url: 'https://spec.example/', title: 'Spec again' }] }],
    other: [{ type: 'link', url: 'https://new.example/', title: 'New' }],
  };
  const merged = bookmarks.merge(tree(), imported);
  assert.deepEqual(shape(merged.tree.bar.children), ['Mail', ['Work', ['Board', ['Projects', ['Spec']]]], ['Reading', ['Blog']]]);
  assert.deepEqual(shape(merged.tree.other.children), ['News', 'New']);
  assert.equal(merged.added, 2);
  assert.equal(merged.skipped, 2);
});

test('simple-browser://bookmarks is a browser page', () => {
  assert.deepEqual(resolveInput('simple-browser://bookmarks'), { ok: true, internal: 'bookmarks' });
});

test('the star files new bookmarks in the folder used last, if it still exists', () => {
  const { tree, ids } = sample();
  assert.equal(sanitizeSettings({ bookmarks: tree(), bookmarkFolder: ids.projects }).bookmarkFolder, ids.projects);
  assert.equal(sanitizeSettings({ bookmarks: tree(), bookmarkFolder: ids.mail }).bookmarkFolder, 'bar', 'a link is not a folder');
  assert.equal(sanitizeSettings({ bookmarks: tree(), bookmarkFolder: 'gone' }).bookmarkFolder, 'bar');
});
