'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createBookmarkActions, MAX_OPEN_AT_ONCE } = require('../../src/main/actions/bookmark-actions');
const { sanitizeTree, find } = require('../../src/main/bookmarks');

// The bookmark actions with stand-ins for the app's parts; `calls` records what they did.
function setup(raw, { dialogAnswer = 0 } = {}) {
  const calls = [];
  const record = (name) => (...args) => { calls.push([name, ...args]); };
  const settings = {
    data: { bookmarks: sanitizeTree(raw), bookmarkFolder: 'bar', showBookmarksBar: true },
    update(patch) { Object.assign(this.data, patch); },
  };
  const page = { view: { webContents: { isLoading: () => false, send: record('send'), once: () => {} } } };
  const actions = createBookmarkActions({
    settings,
    bookmarkIcons: { get: (url) => (url.endsWith('/a') ? 'data:image/png;base64,AAAA' : undefined), set: () => true },
    keepBookmarkIcons: record('keepIcons'),
    tabs: { active: null, navigate: record('navigate'), create: record('create'), openInternal: () => page },
    host: { setRevealed: () => {}, setBookmarksBar: record('setBookmarksBar') },
    ui: { webContents: { focus: () => {}, send: () => {} } },
    win: {},
    dialog: { showMessageBox: async () => { calls.push(['ask']); return { response: dialogAnswer }; } },
    clipboard: { writeText: record('copy') },
    notify: record('notify'),
    pushState: () => {},
    broadcastToLibrary: () => {},
  });
  const idOf = (title) => {
    const walk = (folder) => {
      for (const node of folder.children) {
        if (node.title === title) return node.id;
        if (node.type === 'folder') {
          const found = walk(node);
          if (found) return found;
        }
      }
      return null;
    };
    return walk(settings.data.bookmarks.bar) ?? walk(settings.data.bookmarks.other);
  };
  return { actions, calls, settings, idOf };
}

const TREE = {
  bar: { children: [
    { type: 'link', url: 'https://example.com/a', title: 'A' },
    { type: 'folder', title: 'Work', children: [
      { type: 'link', url: 'https://example.com/w1', title: 'W1' },
      { type: 'folder', title: 'Deep', children: [{ type: 'link', url: 'https://example.com/d1', title: 'D1' }] },
    ] },
  ] },
  other: { children: [{ type: 'link', url: 'https://example.com/o', title: 'O' }] },
};

test('a folder is listed one level at a time, with counts and site icons', () => {
  const { actions, idOf } = setup(TREE);
  const work = actions.bookmarkFolder(idOf('Work'));
  assert.equal(work.count, 2);
  assert.deepEqual(work.children.map((node) => [node.type, node.title, node.count ?? null]), [['link', 'W1', null], ['folder', 'Deep', 1]]);
  assert.equal(work.children[1].children, undefined, 'subfolders come one level at a time');
  assert.equal(actions.bookmarkFolder('bar').children[0].icon, 'data:image/png;base64,AAAA');
  assert.equal(actions.bookmarkFolder(idOf('A')), null, 'a bookmark is not a folder');
  assert.equal(actions.bookmarkFolder('missing'), null);
});

test('menu actions open, copy and open all by id', () => {
  const { actions, calls, idOf } = setup(TREE);
  assert.equal(actions.bookmarkAction(idOf('A'), 'open'), true);
  assert.equal(actions.bookmarkAction(idOf('A'), 'tab'), true);
  assert.equal(actions.bookmarkAction(idOf('A'), 'private'), true);
  assert.equal(actions.bookmarkAction(idOf('A'), 'copy'), true);
  assert.equal(actions.bookmarkAction(idOf('Work'), 'open-all'), true);
  assert.deepEqual(calls.filter(([name]) => name !== 'notify'), [
    ['navigate', 'https://example.com/a'],
    ['create', { url: 'https://example.com/a' }],
    ['create', { url: 'https://example.com/a', isPrivate: true }],
    ['copy', 'https://example.com/a'],
    ['create', { url: 'https://example.com/w1', activate: true }],
    ['create', { url: 'https://example.com/d1', activate: false }],
  ]);
});

test('actions that do not fit are refused', () => {
  const { actions, calls, idOf } = setup(TREE);
  assert.equal(actions.bookmarkAction(idOf('Work'), 'copy'), false, 'a folder has no address');
  assert.equal(actions.bookmarkAction(idOf('A'), 'open-all'), false);
  assert.equal(actions.bookmarkAction('missing', 'open'), false);
  assert.equal(actions.bookmarkAction('bar', 'edit'), false, 'Bookmarks bar cannot be renamed');
  assert.equal(actions.bookmarkAction('other', 'delete'), false, 'Other bookmarks cannot be deleted');
  assert.deepEqual(calls, []);
});

test('deleting a folder with bookmarks asks first; No keeps it', async () => {
  const keep = setup(TREE, { dialogAnswer: 1 });
  assert.equal(await keep.actions.deleteBookmark(keep.idOf('Work')), false);
  assert.ok(find(keep.settings.data.bookmarks, keep.idOf('Work')));
  assert.equal(keep.calls.filter(([name]) => name === 'ask').length, 1);

  const remove = setup(TREE, { dialogAnswer: 0 });
  const work = remove.idOf('Work');
  assert.equal(await remove.actions.bookmarkAction(work, 'delete'), true);
  assert.equal(find(remove.settings.data.bookmarks, work), null);

  const single = setup(TREE);
  assert.equal(await single.actions.deleteBookmark(single.idOf('A')), true);
  assert.equal(single.calls.filter(([name]) => name === 'ask').length, 0, 'a single bookmark is deleted without asking');
});

test('Open all opens at most 50 tabs and says so', () => {
  const many = { bar: { children: Array.from({ length: 60 }, (_, i) => ({ type: 'link', url: `https://example.com/${i}`, title: `B${i}` })) } };
  const { actions, calls } = setup(many);
  assert.equal(actions.openBookmarks(['bar']), MAX_OPEN_AT_ONCE);
  assert.equal(calls.filter(([name]) => name === 'create').length, MAX_OPEN_AT_ONCE);
  assert.ok(calls.some(([name, text]) => name === 'notify' && /first 50 of 60/.test(text)));
});
