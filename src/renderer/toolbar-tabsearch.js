'use strict';

// ---------- Tab search ----------
// Ctrl+Shift+A, or the button at the end of the tab strip, opens a list of the open tabs to
// search by title or address. Arrow keys choose, Enter goes to the tab, Ctrl+Delete closes it,
// Esc closes the list. It works from the toolbar's own state: nothing new is asked of the page.
let tabSearchOpen = false;
let tabSearchIndex = 0;
let tabSearchShown = [];

// Every word typed must be in the title or the address.
function tabMatches(tab, words) {
  const text = `${tab.title}\n${tab.url}`.toLowerCase();
  return words.every((word) => text.includes(word));
}

// The text, with the first place the query (or its first word) appears in bold.
function withMark(text, query) {
  const span = element('span');
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const lower = text.toLowerCase();
  const needle = words.find((word) => lower.includes(word)) ?? '';
  const at = needle ? lower.indexOf(needle) : -1;
  if (at < 0) {
    span.textContent = text;
    return span;
  }
  span.append(text.slice(0, at), element('mark', undefined, text.slice(at, at + needle.length)), text.slice(at + needle.length));
  return span;
}

function tabSearchRow(tab, index, query) {
  const row = element('li', 'ts-row');
  row.id = `tabSearch-${tab.id}`;
  row.setAttribute('role', 'option');
  row.setAttribute('aria-selected', String(index === tabSearchIndex));
  if (tab.favicon) {
    const icon = element('img', 'ts-icon');
    icon.src = tab.favicon;
    icon.alt = '';
    row.append(icon);
  } else {
    row.append(element('span', 'ts-icon'));
  }
  const main = element('div', 'ts-main');
  const title = element('div', 'ts-title');
  title.append(withMark(tab.title || tab.url || 'New tab', query));
  const address = element('div', 'ts-url');
  address.append(withMark(tab.url, query));
  main.append(title, address);
  row.append(main);
  const tags = [];
  if (tab.crashed) tags.push(['Crashed', 'crashed']);
  if (tab.audible && !tab.muted) tags.push(['Playing', 'sound']);
  if (tab.muted) tags.push(['Muted', 'sound']);
  if (tab.isPrivate) tags.push(['Private', 'private']);
  if (tab.id === state.activeId) tags.push(['This tab', 'current']);
  for (const [text, kind] of tags) row.append(element('span', `ts-tag ${kind}`, text));
  row.addEventListener('mousedown', (event) => event.preventDefault()); // keep the focus in the box
  row.addEventListener('click', () => goToTab(tab.id));
  return row;
}

function renderTabSearch() {
  if (!tabSearchOpen) return;
  const query = $('tabSearchInput').value.trim();
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  tabSearchShown = state.tabs.filter((tab) => tabMatches(tab, words));
  tabSearchIndex = Math.min(tabSearchIndex, Math.max(0, tabSearchShown.length - 1));
  $('tabSearchCount').textContent = query ? `${tabSearchShown.length} of ${state.tabs.length} tabs` : `${state.tabs.length} tabs`;
  const list = $('tabSearchList');
  list.replaceChildren(...(tabSearchShown.length
    ? tabSearchShown.map((tab, index) => tabSearchRow(tab, index, query))
    : [element('li', 'ts-empty', 'No open tab matches.')]));
  const chosen = tabSearchShown[tabSearchIndex];
  if (chosen) {
    $('tabSearchInput').setAttribute('aria-activedescendant', `tabSearch-${chosen.id}`);
    $(`tabSearch-${chosen.id}`)?.scrollIntoView({ block: 'nearest' });
  } else {
    $('tabSearchInput').removeAttribute('aria-activedescendant');
  }
  const panel = $('tabSearchPanel');
  panel.style.top = `${chromeHeight() + 8}px`;
  panel.style.left = `${Math.max(8, Math.round((window.innerWidth - panel.offsetWidth) / 2))}px`;
  requestOverlay('tabsearch', panel.getBoundingClientRect().bottom + 12 - chromeHeight());
}

function goToTab(id) {
  closeTabSearch();
  api.tabs.activate(id);
}

async function openTabSearch() {
  if (tabSearchOpen) {
    $('tabSearchInput').focus();
    $('tabSearchInput').select();
    return;
  }
  if (starBookmark) await closeStar(true);
  closeShield();
  closeDownloads();
  closeVideos();
  closeSite();
  tabSearchOpen = true;
  $('tabSearchInput').value = '';
  // Start on the tab after this one: searching is usually for another tab.
  const at = state.tabs.findIndex((tab) => tab.id === state.activeId);
  tabSearchIndex = state.tabs.length > 1 ? (at + 1) % state.tabs.length : 0;
  $('tabSearchPanel').hidden = false;
  $('tabSearchButton').setAttribute('aria-expanded', 'true');
  renderTabSearch();
  $('tabSearchInput').focus();
}

function closeTabSearch() {
  if (!tabSearchOpen) return;
  tabSearchOpen = false;
  $('tabSearchPanel').hidden = true;
  $('tabSearchButton').setAttribute('aria-expanded', 'false');
  requestOverlay('tabsearch', 0);
}

$('tabSearchButton').addEventListener('click', () => (tabSearchOpen ? closeTabSearch() : openTabSearch()));
$('tabSearchInput').addEventListener('input', () => {
  tabSearchIndex = 0;
  renderTabSearch();
});
$('tabSearchInput').addEventListener('keydown', (event) => {
  const chosen = tabSearchShown[tabSearchIndex];
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    if (tabSearchShown.length === 0) return;
    const step = event.key === 'ArrowDown' ? 1 : -1;
    tabSearchIndex = (tabSearchIndex + step + tabSearchShown.length) % tabSearchShown.length;
    renderTabSearch();
  } else if (event.key === 'Enter') {
    event.preventDefault();
    if (chosen) goToTab(chosen.id);
  } else if (event.key === 'Delete' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    if (chosen) api.tabs.close(chosen.id); // the list follows the new state
  } else if (event.key === 'Escape') {
    event.preventDefault();
    closeTabSearch();
  }
});
document.addEventListener('mousedown', (event) => {
  if (tabSearchOpen && !$('tabSearchPanel').contains(event.target) && !$('tabSearchButton').contains(event.target)) closeTabSearch();
});
api.onTabSearch(openTabSearch);
