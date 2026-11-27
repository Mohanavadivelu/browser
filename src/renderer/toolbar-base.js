'use strict';

// Shared by the toolbar's scripts (loaded first): the bridge, the state from the main
// process, small DOM helpers, and the room the toolbar's view takes below the bars.

const api = window.browserApi;
const $ = (id) => document.getElementById(id);

let state = null;
let addressFocused = false;
let pointerInside = false;
let noticeTimer;
let hideTimer;

function activeTabUrl(view) {
  return view.tabs.find((tab) => tab.id === view.activeId)?.url ?? '';
}

function activeTab() {
  return state?.tabs.find((tab) => tab.id === state.activeId) ?? null;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// ---------- Room below the bars ----------
// The suggestion list, the star's popover and the shield's panel hang below the bars, over the
// page; the toolbar's view grows by the most any of them needs.
// Resolves to the window's height, so a menu knows how far down it can reach.
const overlayHeights = { suggestions: 0, star: 0, shield: 0, downloads: 0, videos: 0, site: 0, tabsearch: 0, menu: 0 };
function requestOverlay(name, height) {
  overlayHeights[name] = Math.max(0, Math.min(Math.ceil(height), 4000));
  return api.window.setSuggestionsHeight(Math.max(...Object.values(overlayHeights)));
}

const chromeHeight = () => document.querySelector('.chrome').offsetHeight;

const SVG = 'http://www.w3.org/2000/svg';
function folderIcon(muted) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', `folder-icon${muted ? ' muted' : ''}`);
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z');
  svg.append(path);
  return svg;
}
