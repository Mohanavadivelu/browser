'use strict';

// The two ends of the IPC between the browser's own pages and the main process must agree:
// every function the preload bridge exposes sends on a channel the main process handles, every
// channel handled is reachable from the bridge, and each page only calls what its role allows.
// A mismatch would otherwise show up only as a button that silently does nothing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createIpc } = require('../../src/main/security/ipc-validate');
const { registerIpcHandlers } = require('../../src/main/ipc-handlers');

const ROOT = path.join(__dirname, '..', '..', 'src');
const RENDERER = path.join(ROOT, 'renderer');

// The bridge as the preload builds it, with Electron's modules stood in for: each exposed
// function, called, says which channel it invokes (or listens on).
function loadBridge() {
  let exposed = null;
  let last = null;
  const electron = {
    contextBridge: { exposeInMainWorld: (_name, api) => { exposed = api; } },
    ipcRenderer: {
      invoke: (channel) => { last = { kind: 'invoke', channel }; return Promise.resolve(); },
      on: (channel) => { last = { kind: 'on', channel }; },
      removeListener: () => {},
    },
  };
  const source = fs.readFileSync(path.join(ROOT, 'preload', 'preload.js'), 'utf8');
  // eslint-disable-next-line no-new-func
  new Function('require', source)((name) => {
    if (name === 'electron') return electron;
    throw new Error(`the preload must not need ${name}`);
  });
  const channelOf = (fn) => {
    last = null;
    fn(1, 1);
    return last;
  };
  return { exposed, channelOf };
}

// Every exposed function, by its path ("downloads.pause").
function bridgeFunctions(api, prefix = '') {
  const found = [];
  for (const [key, value] of Object.entries(api)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'function') found.push([name, value]);
    else if (value && typeof value === 'object') found.push(...bridgeFunctions(value, name));
  }
  return found;
}

// Which role each channel allows: a call from a role it doesn't allow is refused by name.
function mainChannels() {
  const handlers = new Map();
  const ipcMain = { removeHandler: () => {}, handle: (channel, fn) => handlers.set(channel, fn) };
  registerIpcHandlers(createIpc(ipcMain, (event) => event.role), {});
  const junk = [Symbol('a'), Symbol('b'), Symbol('c')];
  const allows = (channel, role) => {
    try {
      handlers.get(channel)({ role }, ...junk);
    } catch (error) {
      return !/from the \w+ page/.test(error.message);
    }
    return true;
  };
  return { channels: [...handlers.keys()], allows };
}

// The bridge functions a page's scripts call (window.browserApi is `api` in them).
function callsIn(page) {
  const html = fs.readFileSync(path.join(RENDERER, page), 'utf8');
  const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((match) => match[1]);
  const calls = new Set();
  for (const file of scripts) {
    const text = fs.readFileSync(path.join(RENDERER, file), 'utf8');
    for (const match of text.matchAll(/\bapi\.([a-zA-Z]+)(?:\.([a-zA-Z]+))?\s*\(/g)) calls.add(match[2] ? `${match[1]}.${match[2]}` : match[1]);
  }
  return calls;
}

const PAGES = { 'index.html': 'toolbar', 'library.html': 'library', 'find.html': 'find', 'indicator.html': 'indicator' };

test('every bridge function sends on a channel the main process handles, and none is left out', () => {
  const { exposed, channelOf } = loadBridge();
  const { channels } = mainChannels();
  const invoked = new Set();
  const listened = new Set();
  for (const [name, fn] of bridgeFunctions(exposed)) {
    const call = channelOf(fn);
    assert.ok(call, `${name} sends nothing`);
    if (call.kind === 'invoke') {
      assert.ok(channels.includes(call.channel), `${name} invokes "${call.channel}", which the main process doesn't handle`);
      invoked.add(call.channel);
    } else {
      listened.add(call.channel);
    }
  }
  const unreachable = channels.filter((channel) => !invoked.has(channel));
  assert.deepEqual(unreachable, [], 'channels the main process handles that no page can call');
  assert.ok(listened.size >= 10, 'the pages listen for the main process too');
});

test('each page calls only bridge functions that exist and that its role may use', () => {
  const { exposed, channelOf } = loadBridge();
  const { allows } = mainChannels();
  const functions = new Map(bridgeFunctions(exposed));
  const problems = [];
  for (const [page, role] of Object.entries(PAGES)) {
    for (const name of callsIn(page)) {
      const fn = functions.get(name);
      if (!fn) {
        problems.push(`${page} calls api.${name}, which the bridge doesn't have`);
        continue;
      }
      const call = channelOf(fn);
      if (call.kind === 'invoke' && !allows(call.channel, role)) problems.push(`${page} (${role}) calls ${call.channel}, which its role may not`);
    }
  }
  assert.deepEqual(problems, []);
});

test('the pages that show web content get no bridge calls at all', () => {
  for (const page of ['newtab.html', 'warning.html']) assert.deepEqual([...callsIn(page)], [], page);
});
