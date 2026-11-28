// @ts-check
'use strict';

// Split tabs: two tabs shown side by side in one window. This holds the parts that need no
// Electron: where each side goes, how the bar between them snaps, and checking saved splits.
// The tab manager (tabs.js) keeps the splits; the window (window.js) lays them out.

// The space around and between the sides, in pixels: an outer margin, each side's header (its
// site and ⋯ menu), and the bar between them that is dragged to resize.
const MARGIN = 6;
const HEADER = 28;
const GAP = 10;
// Narrower than this, only the side in use is shown (with a switch to the other).
const NARROW_WIDTH = 760;
// Each side keeps at least a quarter of the width; the bar snaps to a third, a half and two
// thirds when it comes close.
const MIN_RATIO = 0.25;
const MAX_RATIO = 0.75;
const SNAPS = Object.freeze([1 / 3, 1 / 2, 2 / 3]);
const SNAP_DISTANCE = 0.02;
const MAX_SPLITS = 50;

const clampRatio = (ratio) => Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));

// The ratio the bar settles on: within range, and on a snap point when close to one.
function snapRatio(ratio) {
  if (!Number.isFinite(ratio)) return 0.5;
  const clamped = clampRatio(ratio);
  const near = SNAPS.find((snap) => Math.abs(snap - clamped) <= SNAP_DISTANCE);
  return near ?? Math.round(clamped * 1000) / 1000;
}

// Where the two sides go in the page area ({ x, y, width, height }, in window pixels), for the
// left side's share `ratio` and the side in use. In a narrow window only that side is shown.
// Returns { narrow, left, right, divider } with null for a side that isn't shown.
function splitRects(area, ratio, focused = 'left') {
  const narrow = area.width < NARROW_WIDTH;
  const y = area.y + MARGIN + HEADER;
  const height = Math.max(0, area.height - 2 * MARGIN - HEADER);
  if (narrow) {
    const whole = { x: area.x + MARGIN, y, width: Math.max(0, area.width - 2 * MARGIN), height };
    return { narrow, left: focused === 'left' ? whole : null, right: focused === 'right' ? whole : null, divider: null };
  }
  const inner = Math.max(0, area.width - 2 * MARGIN - GAP);
  const leftWidth = Math.round(inner * clampRatio(ratio));
  const left = { x: area.x + MARGIN, y, width: leftWidth, height };
  const right = { x: left.x + leftWidth + GAP, y, width: inner - leftWidth, height };
  const divider = { x: left.x + leftWidth, y: area.y + MARGIN, width: GAP, height: height + HEADER };
  return { narrow, left, right, divider };
}

// The ratio for a pointer at `clientX` in the page area of width `width` (the bar's middle
// follows the pointer).
function ratioAt(clientX, width) {
  const inner = width - 2 * MARGIN - GAP;
  if (inner <= 0) return 0.5;
  return (clientX - MARGIN - GAP / 2) / inner;
}

// Splits from a saved session: [{ tabs: [left, right], ratio, focused }] with places in the
// saved list of addresses. `placeOf` maps a saved place to its place in the checked list; each
// place is used once, and the two sides must be next to each other.
function sanitizeSplits(raw, placeOf) {
  const taken = new Set();
  const splits = [];
  for (const split of Array.isArray(raw) ? raw.slice(0, MAX_SPLITS) : []) {
    if (split === null || typeof split !== 'object' || !Array.isArray(split.tabs) || split.tabs.length !== 2) continue;
    const [left, right] = split.tabs.map((index) => placeOf.get(index));
    if (left === undefined || right === undefined || right !== left + 1 || taken.has(left) || taken.has(right)) continue;
    taken.add(left);
    taken.add(right);
    splits.push({
      tabs: [left, right],
      ratio: typeof split.ratio === 'number' ? snapRatio(split.ratio) : 0.5,
      focused: split.focused === 'right' ? 'right' : 'left',
    });
  }
  return splits;
}

module.exports = {
  MARGIN, HEADER, GAP, NARROW_WIDTH, MIN_RATIO, MAX_RATIO, SNAPS,
  clampRatio, snapRatio, splitRects, ratioAt, sanitizeSplits,
};
