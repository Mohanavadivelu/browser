'use strict';

// Dark pages: with the setting on, websites are shown dark. Sites with a dark design of their
// own use it (the browser asks for dark colours, as Windows' dark mode does); a page that still
// comes out light is darkened by inverting its colours, with pictures and videos inverted back.
// Sites the user keeps light (settings.darkPagesLight) are left as they are.
const DARK_WORLD = 1211;
const DARK_CSS = [
  // The page's canvas is given a near-white of its own (told apart when the page is checked again).
  'html { filter: invert(1) hue-rotate(180deg) !important; background-color: rgb(255, 255, 254) !important; }',
  'img, picture, video, canvas, iframe, embed, object, svg image { filter: invert(1) hue-rotate(180deg) !important; }',
].join('\n');
// How light the page's own background is, from 0 (black) to 1 (white). A page with no background
// of its own is as light as its canvas: dark if it asks for dark colours, or if its text is light.
// (The darkening filter does not change these values, so a darkened page can be checked again.)
const LIGHTNESS = `(() => {
  const parse = (value) => {
    const match = /rgba?[(]([^)]+)[)]/.exec(value);
    if (!match) return null;
    const [r, g, b, a = 1] = match[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return a === 0 ? null : (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  };
  const background = (element) => {
    const value = element ? getComputedStyle(element).backgroundColor : '';
    return value === 'rgb(255, 255, 254)' ? null : parse(value);
  };
  const own = background(document.body) ?? background(document.documentElement);
  if (own !== null) return own;
  if (/dark/.test(getComputedStyle(document.documentElement).colorScheme)) return 0;
  const text = document.body ? parse(getComputedStyle(document.body).color) : null;
  return text !== null && text > 0.6 ? 1 - text : 1;
})()`;

const isLight = (lightness) => Number.isFinite(lightness) && lightness > 0.5;

class DarkPages {
  // `enabled()` is the setting; `keptLight(host)` whether the user keeps that site light.
  constructor({ enabled, keptLight }) {
    this.enabled = enabled;
    this.keptLight = keptLight;
    this.inserted = new WeakMap(); // contents -> the key of the darkening style
  }

  watch(contents) {
    const apply = () => this.apply(contents).catch(() => {});
    contents.on('dom-ready', apply);
    contents.on('did-finish-load', apply);
    // A new page starts without the style.
    contents.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) this.inserted.delete(contents);
    });
  }

  wanted(contents) {
    let host = '';
    try {
      const url = new URL(contents.getURL());
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
      host = url.hostname;
    } catch {
      return false;
    }
    return this.enabled() && !this.keptLight(host);
  }

  isDarkened(contents) {
    return this.inserted.has(contents);
  }

  // Darkens the page if it should be and is light; undoes it if it shouldn't be, or if the page
  // turned out to be dark once its styles loaded.
  async apply(contents) {
    if (contents.isDestroyed()) return false;
    if (!this.wanted(contents)) {
      await this.undo(contents);
      return false;
    }
    const lightness = await contents.executeJavaScriptInIsolatedWorld(DARK_WORLD, [{ code: LIGHTNESS }]);
    if (contents.isDestroyed()) return false;
    if (!isLight(lightness) || !this.wanted(contents)) {
      await this.undo(contents);
      return false;
    }
    if (this.inserted.has(contents)) return true;
    const key = await contents.insertCSS(DARK_CSS, { cssOrigin: 'user' });
    // Asked twice at once (both events): keep one style.
    if (this.inserted.has(contents)) await contents.removeInsertedCSS(key).catch(() => {});
    else this.inserted.set(contents, key);
    return true;
  }

  async undo(contents) {
    const key = this.inserted.get(contents);
    if (!key) return;
    this.inserted.delete(contents);
    if (!contents.isDestroyed()) await contents.removeInsertedCSS(key).catch(() => {});
  }
}

module.exports = { DarkPages, DARK_CSS, LIGHTNESS, isLight };
