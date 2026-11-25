'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RENDERER = path.join(__dirname, '..', '..', 'src', 'renderer');

// The scripts a page loads, in order.
function scriptsOf(page) {
  const html = fs.readFileSync(path.join(RENDERER, page), 'utf8');
  return [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((match) => match[1]);
}

// Top-level names a classic script declares (they share one scope with the page's other scripts).
function topLevelNames(file) {
  const text = fs.readFileSync(path.join(RENDERER, file), 'utf8');
  return [...text.matchAll(/^(?:const|let|var|function|async function|class)\s+([A-Za-z_$][\w$]*)/gm)].map((match) => match[1]);
}

// A name declared twice across a page's scripts stops the second script from loading at all,
// which no syntax check of a single file catches.
for (const page of ['index.html', 'library.html']) {
  test(`the scripts of ${page} do not declare the same top-level name twice`, () => {
    const seen = new Map();
    const clashes = [];
    for (const file of scriptsOf(page)) {
      for (const name of topLevelNames(file)) {
        if (seen.has(name)) clashes.push(`${name} in ${seen.get(name)} and ${file}`);
        else seen.set(name, file);
      }
    }
    assert.deepEqual(clashes, []);
  });
}

test('the toolbar loads its parts before the script that wires them', () => {
  const scripts = scriptsOf('index.html');
  assert.equal(scripts[scripts.length - 1], 'app.js');
  assert.ok(scripts.indexOf('toolbar-base.js') < scripts.indexOf('toolbar-tabs.js'));
  for (const file of scripts) assert.ok(fs.existsSync(path.join(RENDERER, file)), file);
});
