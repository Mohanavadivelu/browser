'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createShortcutHandler } = require('../../src/main/shortcuts');
const { validators } = require('../../src/main/security/ipc-validate');

function setup(modeOverrides = {}) {
  const calls = [];
  const record = (name) => (...args) => calls.push([name, ...args]);
  const tabs = {
    activeId: 7,
    create: record('create'),
    close: record('close'),
    reload: record('reload'),
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
    zoom: record('zoom'),
    find: record('find'),
    openLibrary: record('openLibrary'),
    toggleRecording: record('toggleRecording'),
    togglePause: record('togglePause'),
    screenshot: record('screenshot'),
  };
  const handler = createShortcutHandler({ tabs, host, ui, actions });
  const press = (input) => {
    let prevented = false;
    handler({ preventDefault: () => { prevented = true; } }, { type: 'keyDown', control: false, shift: false, alt: false, ...input });
    return prevented;
  };
  return { calls, press };
}

test('new shortcuts trigger their actions and are consumed', () => {
  const { calls, press } = setup();
  assert.equal(press({ key: 'f', control: true }), true);
  assert.equal(press({ key: 'h', control: true }), true);
  assert.equal(press({ key: 'j', control: true }), true);
  assert.equal(press({ key: 'R', control: true, shift: true }), true);
  assert.equal(press({ key: 'P', control: true, shift: true }), true);
  assert.equal(press({ key: 'S', control: true, shift: true }), true);
  assert.deepEqual(calls.map((call) => call.join(':')), [
    'find', 'openLibrary:history', 'openLibrary:downloads', 'toggleRecording', 'togglePause', 'screenshot',
  ]);
});

test('zoom shortcuts map to in, out and reset', () => {
  const { calls, press } = setup();
  press({ key: '=', control: true });
  press({ key: '+', control: true });
  press({ key: '-', control: true });
  press({ key: '0', control: true });
  assert.deepEqual(calls, [['zoom', 1], ['zoom', 1], ['zoom', -1], ['zoom', 0]]);
});

test('Ctrl+R reloads but Ctrl+Shift+R starts recording instead', () => {
  const { calls, press } = setup();
  press({ key: 'r', control: true });
  press({ key: 'R', control: true, shift: true });
  assert.deepEqual(calls.map((call) => call[0]), ['reload', 'toggleRecording']);
});

test('Esc closes the find bar first and only then leaves full screen', () => {
  const withFind = setup({ findOpen: true, fullscreen: true });
  withFind.press({ key: 'Escape' });
  assert.deepEqual(withFind.calls.map((call) => call[0]), ['closeFind']);

  const fullscreenOnly = setup({ fullscreen: true });
  fullscreenOnly.press({ key: 'Escape' });
  assert.deepEqual(fullscreenOnly.calls.map((call) => call[0]), ['exitFullscreen']);

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
