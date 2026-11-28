'use strict';

// Split tabs: where the two sides go, how the bar snaps, saved splits, the IPC arguments and the
// shortcut.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  splitRects, snapRatio, ratioAt, sanitizeSplits, MARGIN, HEADER, GAP, NARROW_WIDTH,
} = require('../../src/main/split-view');
const { sanitizeSettings } = require('../../src/main/storage/settings');
const { validators } = require('../../src/main/security/ipc-validate');
const { createShortcutHandler } = require('../../src/main/shortcuts');

const AREA = { x: 0, y: 116, width: 1280, height: 684 };

test('the two sides share the width, with room for their headers and the bar', () => {
  const { narrow, left, right, divider } = splitRects(AREA, 0.5);
  assert.equal(narrow, false);
  const inner = AREA.width - 2 * MARGIN - GAP;
  assert.deepEqual(left, { x: MARGIN, y: AREA.y + MARGIN + HEADER, width: inner / 2, height: AREA.height - 2 * MARGIN - HEADER });
  assert.equal(right.x, left.x + left.width + GAP);
  assert.equal(right.x + right.width, AREA.width - MARGIN, 'the right side ends at the margin');
  assert.deepEqual(divider, { x: left.x + left.width, y: AREA.y + MARGIN, width: GAP, height: left.height + HEADER });
  const wide = splitRects(AREA, 0.6);
  assert.equal(wide.left.width, Math.round(inner * 0.6));
  assert.equal(wide.left.width + wide.right.width, inner);
});

test('a side never gets less than a quarter, whatever ratio is asked for', () => {
  const tiny = splitRects(AREA, 0.01);
  const inner = AREA.width - 2 * MARGIN - GAP;
  assert.equal(tiny.left.width, Math.round(inner * 0.25));
  assert.equal(splitRects(AREA, 0.99).right.width, inner - Math.round(inner * 0.75));
});

test('in a narrow window only the side in use is shown, across the whole width', () => {
  const area = { ...AREA, width: NARROW_WIDTH - 1 };
  const shown = splitRects(area, 0.5, 'right');
  assert.equal(shown.narrow, true);
  assert.equal(shown.left, null);
  assert.equal(shown.divider, null);
  assert.deepEqual(shown.right, { x: MARGIN, y: area.y + MARGIN + HEADER, width: area.width - 2 * MARGIN, height: area.height - 2 * MARGIN - HEADER });
  assert.equal(splitRects(area, 0.5, 'left').right, null);
});

test('the bar snaps to a third, a half and two thirds, and stays within range', () => {
  assert.equal(snapRatio(0.51), 0.5);
  assert.equal(snapRatio(0.345), 1 / 3);
  assert.equal(snapRatio(0.65), 2 / 3);
  assert.equal(snapRatio(0.6), 0.6);
  assert.equal(snapRatio(0.1), 0.25);
  assert.equal(snapRatio(0.9), 0.75);
  assert.equal(snapRatio(Number.NaN), 0.5);
  assert.equal(snapRatio(0.61234), 0.612);
});

test('the bar follows the pointer: its middle is where the pointer is', () => {
  const { left, divider } = splitRects({ x: 0, y: 0, width: 1000, height: 600 }, 0.6);
  assert.ok(Math.abs(ratioAt(divider.x + GAP / 2, 1000) - left.width / (1000 - 2 * MARGIN - GAP)) < 1e-9);
  assert.equal(ratioAt(500, 2 * MARGIN + GAP), 0.5, 'no room: an even split');
});

test('saved splits are checked: places that exist, next to each other, each used once', () => {
  const placeOf = new Map([[0, 0], [1, 1], [2, 2], [3, 3], [5, 4]]);
  const splits = sanitizeSplits([
    { tabs: [0, 1], ratio: 0.62, focused: 'right' },
    { tabs: [1, 2] }, // place 1 is taken
    { tabs: [2, 5] }, // not next to each other once checked (2 and 4)
    { tabs: [3, 9] }, // 9 isn't there
    { tabs: [2, 3], ratio: 'wide', focused: 'up' },
    null, 'x', { tabs: [0] },
  ], placeOf);
  assert.deepEqual(splits, [
    { tabs: [0, 1], ratio: 0.62, focused: 'right' },
    { tabs: [2, 3], ratio: 0.5, focused: 'left' },
  ]);
  assert.deepEqual(sanitizeSplits(undefined, placeOf), []);
});

test('splits are kept in the saved session, following the addresses that are kept', () => {
  const settings = sanitizeSettings({
    session: {
      urls: ['https://a.example/', 'javascript:alert(1)', 'https://b.example/', 'https://c.example/'],
      active: 2,
      splits: [{ tabs: [2, 3], ratio: 0.4, focused: 'right' }, { tabs: [0, 2] }],
    },
  });
  assert.deepEqual(settings.session.urls, ['https://a.example/', 'https://b.example/', 'https://c.example/']);
  // [0, 2] becomes [0, 1] once the bad address is dropped, but 1 is already the left of [1, 2].
  assert.deepEqual(settings.session.splits, [{ tabs: [1, 2], ratio: 0.4, focused: 'right' }]);
});

test('the split calls take only what they need', () => {
  assert.equal(validators.tabSplit(3, 0, 'right'), true);
  assert.equal(validators.tabSplit(3, 7, 'left'), true);
  assert.equal(validators.tabSplit(3, -1, 'left'), false);
  assert.equal(validators.tabSplit(3, 7, 'up'), false);
  assert.equal(validators.tabSplit(0, 7, 'left'), false);
  assert.equal(validators.splitSide('left'), true);
  assert.equal(validators.splitSide('middle'), false);
  assert.equal(validators.splitMenu('right', 10, 20), true);
  assert.equal(validators.splitMenu('right', -1, 20), false);
  assert.equal(validators.splitMenu('right', 1.5, 20), false);
  assert.equal(validators.ratio(0.4), true);
  assert.equal(validators.ratio(1.4), false);
  assert.equal(validators.ratio(Number.NaN), false);
  assert.equal(validators.ratio('0.4'), false);
});

test('Ctrl+Shift+L opens a new tab beside the one in use', () => {
  const calls = [];
  const handler = createShortcutHandler({
    tabs: { active: null },
    host: { mode: {} },
    ui: { webContents: {} },
    actions: { splitWithNewTab: () => calls.push('split') },
  });
  let prevented = false;
  handler({ preventDefault: () => { prevented = true; } }, { type: 'keyDown', key: 'L', control: true, shift: true, alt: false });
  assert.deepEqual(calls, ['split']);
  assert.equal(prevented, true);
});

test('the frame page has no way to the pages and draws everything as text', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/split.js'), 'utf8');
  assert.doesNotMatch(source, /innerHTML/);
  // Only data: icons, from the browser's own fetch.
  assert.match(source, /favicon\?\.startsWith\('data:image\/'\)/);
  const html = fs.readFileSync(path.join(__dirname, '../../src/renderer/split.html'), 'utf8');
  assert.match(html, /default-src 'none'; script-src 'self'; style-src 'self'; img-src data:/);
});
