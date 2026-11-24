'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { suggest } = require('../../src/main/suggestions');

const NOW = Date.UTC(2026, 10, 24);
const DAY = 24 * 60 * 60 * 1000;
const visit = (url, title, daysAgo = 1) => ({ url, title, time: NOW - daysAgo * DAY });

test('the first suggestion is what the typed text does on its own', () => {
  assert.deepEqual(suggest({ text: 'cats and dogs', engine: 'duckduckgo', now: NOW })[0], {
    kind: 'search', url: 'https://duckduckgo.com/?q=cats%20and%20dogs', title: 'Search DuckDuckGo for “cats and dogs”', input: 'cats and dogs',
  });
  assert.equal(suggest({ text: 'example.com/a', now: NOW })[0].kind, 'address');
  assert.equal(suggest({ text: 'example.com/a', now: NOW })[0].url, 'https://example.com/a');
  assert.equal(suggest({ text: 'simple-browser://history', now: NOW })[0].kind, 'page');
  assert.deepEqual(suggest({ text: '   ', now: NOW }), []);
  // A blocked address is not offered as something to open.
  assert.equal(suggest({ text: 'javascript:alert(1)', now: NOW }).length, 0);
});

test('bookmarks and visited pages that contain every typed word follow, best first', () => {
  const history = [
    visit('https://news.example/world', 'World news', 1),
    visit('https://www.github.com/', 'GitHub', 1),
    visit('https://www.github.com/', 'GitHub', 2),
    visit('https://docs.example/git-guide', 'A guide to git', 30),
  ];
  const bookmarks = [{ url: 'https://gitlab.example/', title: 'GitLab' }];
  const results = suggest({ text: 'git', history, bookmarks, now: NOW });
  assert.equal(results[0].kind, 'search');
  assert.deepEqual(results.slice(1).map((r) => [r.kind, r.url]), [
    ['bookmark', 'https://gitlab.example/'],
    ['history', 'https://www.github.com/'],
    ['history', 'https://docs.example/git-guide'],
  ]);
  // Every word has to match.
  assert.deepEqual(suggest({ text: 'git news', history, now: NOW }).slice(1), []);
  assert.deepEqual(suggest({ text: 'world news', history, now: NOW }).slice(1).map((r) => r.url), ['https://news.example/world']);
});

test('a visited page appears once, and not again when it is the typed address', () => {
  const history = [visit('https://example.com/', 'Example', 1), visit('https://example.com/', 'Example Domain', 3)];
  const bookmarks = [{ url: 'https://example.com/', title: 'Example bookmark' }];
  const results = suggest({ text: 'example', history, bookmarks, now: NOW });
  assert.equal(results.filter((r) => r.url === 'https://example.com/').length, 1);
  assert.equal(results[1].kind, 'bookmark');
  const typed = suggest({ text: 'example.com', history, now: NOW });
  assert.deepEqual(typed.map((r) => r.url), ['https://example.com/']);
});

test('at most six suggestions are offered', () => {
  const history = Array.from({ length: 20 }, (_, i) => visit(`https://site${i}.example/`, `Site ${i}`, i));
  assert.equal(suggest({ text: 'site', history, now: NOW }).length, 6);
});
