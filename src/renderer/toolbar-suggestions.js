'use strict';

// ---------- Address-bar suggestions ----------
// The first suggestion is what the typed text does on its own; the arrow keys move through
// the list, Enter or a click opens the selected one, Esc closes it.
//
// Typing at the end of the address bar also completes it inline: the rest of a site the text
// begins (from bookmarks and history, chosen by the main process) is filled in after the caret,
// selected, so typing on replaces it. Tab, → or End accepts it; Backspace or Delete removes it
// and stops completing until the next letter; Esc removes it and closes the list; Enter opens
// the completed address.
const KIND_ICONS = { search: '🔍', address: '🌐', page: '⚙', bookmark: '★', history: '🕘' };
let suggestions = [];
let selected = 0;
let suggestTimer;
let suggestSeq = 0;
let suggestPending = false; // the list is for text typed before the last key
let inline = null; // { typed, text, url } while a completion is shown after the caret

function closeSuggestions() {
  clearTimeout(suggestTimer);
  suggestSeq += 1; // drop answers still on their way
  suggestPending = false;
  suggestions = [];
  inline = null;
  $('completeHint').hidden = true;
  $('suggestions').hidden = true;
  $('suggestions').replaceChildren();
  $('address').setAttribute('aria-expanded', 'false');
  requestOverlay('suggestions', 0);
}

// Shows `completion` (which starts with `typed`, in any case) after the caret, selected.
function showInline(typed, completion, url) {
  const input = $('address');
  input.value = typed + completion.slice(typed.length);
  input.setSelectionRange(typed.length, input.value.length);
  inline = { typed, text: input.value, url };
  $('completeHint').hidden = false;
}

// Whether the completion is still shown as it was put there: only it is selected.
function inlineShown() {
  const input = $('address');
  return Boolean(inline) && input.value === inline.text &&
    input.selectionStart === inline.typed.length && input.selectionEnd === input.value.length;
}

function dropInline() {
  inline = null;
  $('completeHint').hidden = true;
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
    if (item.note) row.append(element('span', 'note', `· ${item.note}`));
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

// Asks for suggestions for what is typed (without a completion shown after it).
function querySuggestions(complete) {
  clearTimeout(suggestTimer);
  const text = inline ? inline.typed : $('address').value;
  if (!text.trim()) {
    closeSuggestions();
    return;
  }
  const seq = ++suggestSeq;
  suggestPending = true;
  suggestTimer = setTimeout(async () => {
    const results = await api.suggest(text.slice(0, 2048), complete);
    if (seq !== suggestSeq || !addressFocused) return;
    suggestPending = false;
    suggestions = results;
    selected = 0;
    const first = results[0];
    const typedNow = inline ? inline.typed : $('address').value;
    if (complete && first?.completion && typedNow === text && (inline ? inlineShown() : caretAtEnd())) {
      showInline(text, first.completion, first.url);
    } else if (inline && inlineShown() && !first?.completion) {
      // A completion kept from the last answer that this one no longer offers.
      $('address').value = inline.typed;
      dropInline();
    }
    renderSuggestions();
  }, 60);
}

function caretAtEnd() {
  const input = $('address');
  return input.selectionStart === input.value.length && input.selectionEnd === input.value.length;
}

// Where Enter or a click goes: the completed site while its text is in the address bar, the
// typed text for the row that stands for it, else the row's address.
function targetOf(item) {
  const value = $('address').value;
  if (!item) return value;
  if (item.completion) return value.toLowerCase() === item.completion.toLowerCase() ? item.url : value;
  return item.input ?? item.url ?? value;
}

function openSuggestion(index) {
  api.nav.go(targetOf(suggestions[index]));
  closeSuggestions();
  $('address').blur();
}

$('address').addEventListener('input', (event) => {
  const previous = inline;
  dropInline();
  // Only typing a letter at the end completes; deleting, pasting or editing in the middle
  // does not.
  const complete = event.inputType === 'insertText' && caretAtEnd();
  const value = $('address').value;
  // The letter typed is the next one of the completion shown: keep the rest without waiting.
  if (complete && previous && previous.text.length > value.length && previous.text.toLowerCase().startsWith(value.toLowerCase())) {
    showInline(value, previous.text, previous.url);
  }
  querySuggestions(complete);
});

$('address').addEventListener('keydown', (event) => {
  const accept = (event.key === 'Tab' && !event.shiftKey) || event.key === 'ArrowRight' || event.key === 'End';
  if (accept && inlineShown()) {
    event.preventDefault();
    const input = $('address');
    input.setSelectionRange(input.value.length, input.value.length);
    dropInline(); // the list stays: its first row is the completed site, which Enter opens
    return;
  }
  if (event.key === 'Escape' && inlineShown()) {
    event.preventDefault();
    $('address').value = inline.typed;
    closeSuggestions();
    return;
  }
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
  // A list made for the text before the last key would open the wrong thing: go by the text
  // itself, or the completion shown after it.
  if (suggestions.length && !suggestPending) {
    openSuggestion(selected);
    return;
  }
  api.nav.go(inlineShown() ? inline.url : $('address').value);
  closeSuggestions();
  $('address').blur();
});
