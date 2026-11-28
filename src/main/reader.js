'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Reading mode: whether a page has an article to read (Mozilla's Readability, in a world of its
// own on the page), and showing or closing it (reader-overlay.js). Nothing here gives the page
// anything of the browser's: the scripts run in an isolated world, and the article is the page's
// own content, shown inside its own document.
const READER_WORLD = 1209;
const CHECK_DELAY_MS = 600;

let library = null;
let overlay = null;

// Readability and its quick check, defined once per page in the reader's world.
function librarySource() {
  if (!library) {
    const dir = path.dirname(require.resolve('@mozilla/readability/package.json'));
    const read = (name) => fs.readFileSync(path.join(dir, name), 'utf8');
    library = `if (!(window.__sbReader && window.__sbReader.Readability)) { (function () { var module; ${read('Readability.js')}
${read('Readability-readerable.js')}
window.__sbReader = { Readability: Readability, isProbablyReaderable: isProbablyReaderable, overlay: null }; })(); }`;
  }
  return library;
}

function overlaySource() {
  overlay ??= fs.readFileSync(path.join(__dirname, 'reader-overlay.js'), 'utf8');
  return overlay;
}

// One script each time: with several, Electron answers with the first one's value.
async function isReaderable(contents) {
  try {
    return (await contents.executeJavaScriptInIsolatedWorld(READER_WORLD, [
      { code: `${librarySource()}
;window.__sbReader.isProbablyReaderable(document)` },
    ])) === true;
  } catch {
    return false;
  }
}

// Opens reading mode, or closes it if open: true (opened), false (closed), null (no article).
async function toggleReader(contents) {
  const result = await contents.executeJavaScriptInIsolatedWorld(READER_WORLD, [
    { code: `${librarySource()}
;${overlaySource()}` },
  ]);
  return result === true || result === false ? result : null;
}

// Keeps each web tab's "has an article" flag, for the address bar's reading mode button.
class ReaderWatch {
  constructor({ onChange = () => {} } = {}) {
    this.onChange = onChange;
  }

  watch(tab) {
    const contents = tab.view.webContents;
    let timer = null;
    const set = (value) => {
      if (Boolean(tab.readerable) === value) return;
      tab.readerable = value;
      this.onChange(tab);
    };
    contents.on('did-navigate', () => set(false));
    contents.on('did-stop-loading', () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        if (contents.isDestroyed() || !/^https?:/i.test(contents.getURL())) return set(false);
        set(await isReaderable(contents));
      }, CHECK_DELAY_MS);
      timer.unref?.();
    });
    contents.once('destroyed', () => clearTimeout(timer));
  }
}

module.exports = { ReaderWatch, isReaderable, toggleReader, librarySource, READER_WORLD };
