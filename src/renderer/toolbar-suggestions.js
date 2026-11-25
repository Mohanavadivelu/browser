'use strict';

// ---------- Address-bar suggestions ----------
// The first suggestion is what the typed text does on its own; the arrow keys move through
// the list, Enter or a click opens the selected one, Esc closes it.
const KIND_ICONS = { search: '🔍', address: '🌐', page: '⚙', bookmark: '★', history: '🕘' };
let suggestions = [];
let selected = 0;
let suggestTimer;
let suggestSeq = 0;

function closeSuggestions() {
  clearTimeout(suggestTimer);
  suggestSeq += 1; // drop answers still on their way
  suggestions = [];
  $('suggestions').hidden = true;
  $('suggestions').replaceChildren();
  $('address').setAttribute('aria-expanded', 'false');
  requestOverlay('suggestions', 0);
}

function renderSuggestions() {
  const list = $('suggestions');
  if (suggestions.length === 0) {
    closeSuggestions();
    return;
  }
  list.replaceChildren(...suggestions.map((item, index) => {
    const row = element('div', `suggestion${index === selected ? ' selected' : ''}`);
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(index === selected));
    row.append(element('span', 'kind', KIND_ICONS[item.kind] ?? '•'), element('span', 'title', item.title));
    if (item.kind === 'bookmark' || item.kind === 'history') row.append(element('span', 'url', item.url));
    // mousedown keeps the focus in the address bar, so the click below still lands.
    row.addEventListener('mousedown', (event) => event.preventDefault());
    row.addEventListener('click', () => openSuggestion(index));
    return row;
  }));
  list.hidden = false;
  $('address').setAttribute('aria-expanded', 'true');
  const needed = Math.ceil(list.getBoundingClientRect().bottom + 8 - document.querySelector('.chrome').offsetHeight);
  requestOverlay('suggestions', needed);
}

function querySuggestions() {
  clearTimeout(suggestTimer);
  const text = $('address').value;
  if (!text.trim()) {
    closeSuggestions();
    return;
  }
  const seq = ++suggestSeq;
  suggestTimer = setTimeout(async () => {
    const results = await api.suggest(text.slice(0, 2048));
    if (seq !== suggestSeq || !addressFocused) return;
    suggestions = results;
    selected = 0;
    renderSuggestions();
  }, 60);
}

function openSuggestion(index) {
  const item = suggestions[index];
  // The first entry is the typed text itself; the main process decides what it means.
  api.nav.go(index === 0 && item?.input ? item.input : item?.url ?? $('address').value);
  closeSuggestions();
  $('address').blur();
}

$('address').addEventListener('input', querySuggestions);
$('address').addEventListener('keydown', (event) => {
  if (suggestions.length === 0) return;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const step = event.key === 'ArrowDown' ? 1 : -1;
    selected = (selected + step + suggestions.length) % suggestions.length;
    renderSuggestions();
  } else if (event.key === 'Escape') {
    event.preventDefault();
    closeSuggestions();
  }
});

$('addressForm').addEventListener('submit', (event) => {
  event.preventDefault();
  if (suggestions.length) {
    openSuggestion(selected);
    return;
  }
  api.nav.go($('address').value);
  $('address').blur();
});
