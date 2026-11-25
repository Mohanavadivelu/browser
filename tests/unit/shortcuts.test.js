'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createShortcutHandler } = require('../../src/main/shortcuts');
const { validators } = require('../../src/main/security/ipc-validate');

function setup(modeOverrides = {}) {
  const calls = [];
  const record = (name) => (...args) => calls.push([name, ...args]);
  const page = { id: 'page' };
  const tabs = {
    activeId: 7,
    active: { view: { webContents: page } },
    create: record('create'),
    close: record('close'),
    reload: record('reload'),
    reloadIgnoringCache: record('reloadIgnoringCache'),
    reopenClosed: record('reopenClosed'),
    back: record('back'),
    forward: record('forward'),
    activateRelative: record('activateRelative'),
  };
  const host = {
    mode: { fullscreen: false, htmlFullscreen: false, findOpen: false, ...modeOverrides },
    toggleFullscreen: record('toggleFullscreen'),
    exitFullscreen: record('exitFullscreen'),
    closeFind: record('closeFind'),
    setRevealed: record('setRevealed'),
  };
  const ui = { webContents: { focus: record('focus'), send: record('send') } };
  const actions = {
    toggleBookmark: record('bookmark'),
    openStar: record('openStar'),
    zoom: record('zoom'),
    find: record('find'),
    openLibrary: record('openLibrary'),
    toggleRecording: record('toggleRecording'),
    togglePause: record('togglePause'),
    screenshot: record('screenshot'),
    print: record('print'),
    addMarker: record('addMarker'),
    toggleBookmarksBar: record('toggleBookmarksBar'),
  };
  const handler = createShortcutHandler({ tabs, host, ui, actions });
  // `from` is where the key was pressed: the active page, or (by default) the browser's own bars.
  const toolbar = { id: 'toolbar' };
  const press = (input, from = toolbar) => {
    let prevented = false;
    handler({ preventDefault: () => { prevented = true; } }, { type: 'keyDown', control: false, shift: false, alt: false, ...input }, from);
    return prevented;
  };
  return { calls, press, page };
}

test('new shortcuts trigger their actions and are consumed', () => {
  const { calls, press } = setup();
  assert.equal(press({ key: 'f', control: true }), true);
  assert.equal(press({ key: 'h', control: true }), true);
  assert.equal(press({ key: 'j', control: true }), true);
  assert.equal(press({ key: 'E', control: true, shift: true }), true);
  assert.equal(press({ key: 'P', control: true, shift: true }), true);
  assert.equal(press({ key: 'S', control: true, shift: true }), true);
  assert.deepEqual(calls.map((call) => call.join(':')), [
    'find', 'openLibrary:history', 'openLibrary:downloads', 'toggleRecording', 'togglePause', 'screenshot',
  ]);
});

test('Ctrl+Shift+T reopens the last closed tab', () => {
  const { calls, press } = setup();
  assert.equal(press({ key: 'T', control: true, shift: true }), true);
  assert.equal(press({ key: 't', control: true }), true);
  assert.deepEqual(calls.map((call) => call[0]), ['reopenClosed', 'create']);
});

test('Ctrl+P prints the page and Ctrl+Shift+O opens the bookmarks page', () => {
  const { calls, press } = setup();
  assert.equal(press({ key: 'p', control: true }), true);
  assert.equal(press({ key: 'O', control: true, shift: true }), true);
  assert.deepEqual(calls.map((call) => call.join(':')), ['print', 'openLibrary:bookmarks']);
});

test('Ctrl+Shift+M adds a marker to the recording', () => {
  const { calls, press } = setup();
  assert.equal(press({ key: 'M', control: true, shift: true }), true);
  assert.deepEqual(calls.map((call) => call[0]), ['addMarker']);
});

test('Ctrl+D opens the star popover for the page', () => {
  const { calls, press } = setup();
  assert.equal(press({ key: 'd', control: true }), true);
  assert.deepEqual(calls.map((call) => call[0]), ['openStar']);
});

test('Ctrl+Shift+B shows or hides the bookmarks bar', () => {
  const { calls, press } = setup();
  assert.equal(press({ key: 'B', control: true, shift: true }), true);
  assert.deepEqual(calls.map((call) => call[0]), ['toggleBookmarksBar']);
});

test('zoom shortcuts map to in, out and reset', () => {
  const { calls, press } = setup();
  press({ key: '=', control: true });
  press({ key: '+', control: true });
  press({ key: '-', control: true });
  press({ key: '0', control: true });
  assert.deepEqual(calls, [['zoom', 1], ['zoom', 1], ['zoom', -1], ['zoom', 0]]);
});

test('Ctrl+R reloads; Ctrl+Shift+R and Ctrl+F5 reload without the cache, as in other browsers', () => {
  const { calls, press } = setup();
  press({ key: 'r', control: true });
  press({ key: 'F5' });
  press({ key: 'R', control: true, shift: true });
  press({ key: 'F5', control: true });
  assert.deepEqual(calls.map((call) => call[0]), ['reload', 'reload', 'reloadIgnoringCache', 'reloadIgnoringCache']);
});

test('Esc closes the find bar first and only then leaves full screen', () => {
  const withFind = setup({ findOpen: true, fullscreen: true });
  withFind.press({ key: 'Escape' });
  assert.deepEqual(withFind.calls.map((call) => call[0]), ['closeFind']);

  const fullscreenOnly = setup({ fullscreen: true });
  fullscreenOnly.press({ key: 'Escape' });
  assert.deepEqual(fullscreenOnly.calls.map((call) => call[0]), ['exitFullscreen']);

  // Pressed in the page, Esc is the page's; holding it down leaves full screen.
  const inPage = setup({ fullscreen: true });
  assert.equal(inPage.press({ key: 'Escape' }, inPage.page), false);
  assert.deepEqual(inPage.calls, []);
  assert.equal(inPage.press({ key: 'Escape', isAutoRepeat: true }, inPage.page), true);
  assert.deepEqual(inPage.calls.map((call) => call[0]), ['exitFullscreen']);

  // The find bar still closes first, wherever Esc is pressed.
  const findInPage = setup({ fullscreen: true, findOpen: true });
  findInPage.press({ key: 'Escape' }, findInPage.page);
  assert.deepEqual(findInPage.calls.map((call) => call[0]), ['closeFind']);

  const neither = setup();
  assert.equal(neither.press({ key: 'Escape' }), false);
});

test('unrelated keys and key releases are ignored', () => {
  const { calls, press } = setup();
  assert.equal(press({ key: 'a' }), false);
  assert.equal(press({ key: 'f', control: true, type: 'keyUp' }), false);
  assert.deepEqual(calls, []);
});

test('IPC validators accept well-formed find, settings and text calls only', () => {
  assert.equal(validators.findQuery('banana', { next: true, forward: false }), true);
  assert.equal(validators.findQuery('banana', {}), true);
  assert.equal(validators.findQuery('x'.repeat(501), {}), false);
  assert.equal(validators.findQuery('banana', { next: 'yes' }), false);
  assert.equal(validators.findQuery('banana'), false);

  assert.equal(validators.settingsPatch({ searchEngine: 'bing' }), true);
  assert.equal(validators.settingsPatch(null), false);
  assert.equal(validators.settingsPatch([]), false);
  assert.equal(validators.settingsPatch(Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, 1]))), false);

  assert.equal(validators.twoTexts('a.webm', 'new name'), true);
  assert.equal(validators.twoTexts('a.webm'), false);
  assert.equal(validators.twoTexts('a.webm', 5), false);

  assert.equal(validators.optionalText(), true);
  assert.equal(validators.optionalText('abc'), true);
  assert.equal(validators.optionalText(5), false);
  assert.equal(validators.optionalText('a', 'b'), false);
});
