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

const DOCS = [
  visit('https://docs.example.dev/', 'Example Docs'),
  visit('https://docs.example.dev/', 'Example Docs'),
  visit('https://docs.example.dev/guide/install', 'Install guide'),
  visit('https://documents.example.org/team/release', 'Release checklist'),
  visit('http://www.dogs.example/', 'Dogs'),
];
const completed = (text, options = {}) => suggest({ text, history: DOCS, now: NOW, complete: true, ...options })[0]?.completion ?? null;

test('typing the start of a site completes it to the site visited most', () => {
  const first = suggest({ text: 'doc', history: DOCS, now: NOW, complete: true });
  assert.deepEqual(first[0], { kind: 'address', url: 'https://docs.example.dev/', title: 'docs.example.dev/', note: 'Example Docs', completion: 'docs.example.dev/' });
  assert.equal(first.at(-1).kind, 'search', 'what the typed text does on its own comes last');
  assert.equal(first.filter((row) => row.url === 'https://docs.example.dev/').length, 1);
  assert.equal(completed('docs.ex'), 'docs.example.dev/');
  assert.equal(completed('Do'), 'Docs.example.dev/', 'what was typed keeps its case');
  assert.equal(completed('www.do'), 'www.docs.example.dev/');
  assert.equal(completed('https://dog'), 'https://dogs.example/');
  assert.equal(suggest({ text: 'dog', history: DOCS, now: NOW, complete: true })[0].url, 'http://www.dogs.example/', 'a site only seen over http stays http');
});

test('past the host it completes to a page, unless the typed address is visited more', () => {
  assert.equal(completed('docs.example.dev/g'), 'docs.example.dev/guide/install');
  assert.equal(completed('docs.example.dev/'), null, 'the site itself is visited more than the page under it');
  assert.equal(completed('docs.example.dev'), 'docs.example.dev/');
});

test('nothing is completed for a search, an unknown start, or without asking', () => {
  assert.equal(completed('doc lists'), null, 'a space means search');
  assert.equal(completed('zebra'), null);
  assert.equal(completed('doc '), null);
  assert.equal(suggest({ text: 'doc', history: DOCS, now: NOW })[0].kind, 'search');
  assert.equal(completed('ftp', { history: [visit('ftp://ftp.example/', 'FTP')] }), null, 'only http(s) addresses');
});

test('bookmarks count towards completion as well as visits', () => {
  const bookmarks = [{ url: 'https://dogfood.example/', title: 'Dog food' }];
  assert.equal(completed('dog', { bookmarks }), 'dogfood.example/', 'a bookmark outweighs one visit');
  assert.equal(completed('dog', { bookmarks, history: [...DOCS, ...Array.from({ length: 5 }, () => visit('https://dogs.example/', 'Dogs'))] }), 'dogs.example/');
});
