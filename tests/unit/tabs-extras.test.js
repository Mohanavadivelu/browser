'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { MemorySaver, MINUTES_CHOICES } = require('../../src/main/memory-saver');
const { sanitizeSettings } = require('../../src/main/storage/settings');
const { validators } = require('../../src/main/security/ipc-validate');
const { librarySource } = require('../../src/main/reader');

const MINUTE = 60 * 1000;

// Tabs as the memory saver sees them: when each went to the background, and whether it may sleep.
function fakeTabs(list) {
  const slept = [];
  return {
    slept,
    tabs: new Map(list.map((tab) => [tab.id, tab])),
    canSleep: async (id) => list.find((tab) => tab.id === id).canSleep !== false,
    sleep: (id) => { slept.push(id); return true; },
  };
}

test('the memory saver puts to sleep only tabs in the background longer than the setting', async () => {
  const now = 1000 * MINUTE;
  const tabs = fakeTabs([
    { id: 1, inactiveSince: null }, // the tab shown
    { id: 2, inactiveSince: now - 40 * MINUTE },
    { id: 3, inactiveSince: now - 10 * MINUTE },
    { id: 4, inactiveSince: now - 90 * MINUTE, canSleep: false }, // playing, pinned, typed into...
    { id: 5, inactiveSince: now - 31 * MINUTE },
  ]);
  let minutes = 30;
  const saver = new MemorySaver({ tabs, minutes: () => minutes, now: () => now });
  assert.equal(await saver.check(), 2);
  assert.deepEqual(tabs.slept, [2, 5]);
  minutes = 0; // off
  assert.equal(await saver.check(), 0);
  assert.deepEqual(MINUTES_CHOICES, [0, 15, 30, 60, 120, 240]);
});

test('pinned tabs and tab groups are kept in the settings, checked when loaded', () => {
  const settings = sanitizeSettings({
    pinnedTabs: ['https://mail.example/', 'javascript:alert(1)', 'https://calendar.example/'],
    memorySaverMinutes: 60,
    session: {
      urls: ['https://a.example/', 'file:///C:/secret.txt', 'https://b.example/', 'https://c.example/'],
      active: 3,
      groups: [
        { name: 'Trip', color: 'blue', collapsed: true, tabs: [0, 2] },
        { name: 'Bad', color: 'neon', tabs: [1] }, // only the dropped address: nothing left
        { name: 'Overlap', color: 'red', tabs: [2, 3] }, // a tab already in a group isn't taken twice
        'nonsense',
      ],
    },
  });
  assert.deepEqual(settings.pinnedTabs, ['https://mail.example/', 'https://calendar.example/']);
  assert.equal(settings.memorySaverMinutes, 60);
  assert.deepEqual(settings.session.urls, ['https://a.example/', 'https://b.example/', 'https://c.example/']);
  assert.equal(settings.session.active, 2, 'the active tab follows the dropped address');
  assert.deepEqual(settings.session.groups, [
    { name: 'Trip', color: 'blue', collapsed: true, tabs: [0, 1] },
    { name: 'Overlap', color: 'red', collapsed: false, tabs: [2] },
  ]);
  const defaults = sanitizeSettings({ memorySaverMinutes: 7 });
  assert.equal(defaults.memorySaverMinutes, 30);
  assert.deepEqual(defaults.pinnedTabs, []);
  assert.deepEqual(defaults.session, { urls: [], active: 0, groups: [], splits: [] });
});

test('the toolbar can only name tabs and groups, and only change a group\u2019s name, colour and folding', () => {
  assert.equal(validators.tabIdAndBool(3, true), true);
  assert.equal(validators.tabIdAndBool(3, 'yes'), false);
  assert.equal(validators.groupId('g12'), true);
  assert.equal(validators.groupId('../g1'), false);
  assert.equal(validators.tabAndGroup(2, 'g1'), true);
  assert.equal(validators.groupPatch('g1', { name: 'Work', color: 'green', collapsed: false }), true);
  assert.equal(validators.groupPatch('g1', { color: 'neon' }), false);
  assert.equal(validators.groupPatch('g1', { tabs: [1] }), false);
  assert.equal(validators.groupPatch('g1', {}), false);
});

test('reading mode\u2019s scripts parse, and Readability is bundled', () => {
  const library = librarySource();
  assert.ok(library.includes('function Readability(') && library.includes('function isProbablyReaderable('));
  assert.doesNotThrow(() => new vm.Script(library));
  const overlay = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main', 'reader-overlay.js'), 'utf8');
  assert.doesNotThrow(() => new vm.Script(overlay));
});
