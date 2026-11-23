'use strict';

const api = window.browserApi;
const input = document.getElementById('query');
const count = document.getElementById('count');

function search(options) {
  api.find.query(input.value, options);
}

function showResult({ active, matches }) {
  if (!input.value) {
    count.textContent = '';
    input.classList.remove('none');
    return;
  }
  count.textContent = matches ? `${active}/${matches}` : 'No results';
  input.classList.toggle('none', matches === 0);
}

input.addEventListener('input', () => search({ next: false, forward: true }));
input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    search({ next: true, forward: !event.shiftKey });
  } else if (event.key === 'Escape') {
    event.preventDefault();
    api.find.close();
  }
});
document.getElementById('next').addEventListener('click', () => search({ next: true, forward: true }));
document.getElementById('prev').addEventListener('click', () => search({ next: true, forward: false }));
document.getElementById('close').addEventListener('click', () => api.find.close());

api.onFindResult(showResult);
api.onFindFocus(() => {
  input.focus();
  input.select();
  if (input.value) search({ next: false, forward: true });
});
