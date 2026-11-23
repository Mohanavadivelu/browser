'use strict';

const { IdleTracker } = require('./idle-tracker');

const DEFAULT_IDLE_MS = 5000;

// Hides the cursor with a constructable stylesheet, which page CSP rules cannot block.
const HIDE_CURSOR_SCRIPT = `(() => {
  if (window.__sbCursor) return;
  const sheet = new CSSStyleSheet();
  sheet.replaceSync('*, *::before, *::after { cursor: none !important; }');
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  window.__sbCursor = sheet;
})()`;

const SHOW_CURSOR_SCRIPT = `(() => {
  const sheet = window.__sbCursor;
  if (!sheet) return;
  document.adoptedStyleSheets = document.adoptedStyleSheets.filter((item) => item !== sheet);
  window.__sbCursor = null;
})()`;

const CHROME_CURSOR_CSS = '*, *::before, *::after { cursor: none !important; }';

// In full screen, after a period without mouse or keyboard activity, hides the top bar
// and the mouse pointer. Any activity brings the pointer back.
class FullscreenIdle {
  constructor({ host, tabs, idleMs = DEFAULT_IDLE_MS, checkMs = 250 }) {
    this.host = host;
    this.tabs = tabs;
    this.checkMs = checkMs;
    this.cursorHidden = false;
    this.hiddenTabs = new Set();
    this.chromeKeys = new Map();
    this.timer = null;
    this.tracker = new IdleTracker({
      idleMs,
      onIdle: () => this.handleIdle(),
      onActive: () => this.showCursor(),
    });
    host.on('mode-change', () => this.sync());
    tabs.on('change', () => {
      if (this.cursorHidden) this.hideTabCursor();
    });
  }

  get immersive() {
    return this.host.mode.fullscreen || this.host.mode.htmlFullscreen;
  }

  sync() {
    if (this.immersive) {
      if (this.tracker.enable()) {
        this.timer = setInterval(() => this.tracker.check(), this.checkMs);
        this.timer.unref?.();
      }
    } else {
      this.tracker.disable();
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  activity() {
    this.tracker.activity();
  }

  handleIdle() {
    if (this.host.mode.revealed) {
      this.host.setRevealed(false);
      // Move keyboard focus off the hidden address bar.
      this.tabs.active?.view.webContents.focus();
    }
    this.hideCursor();
  }

  hideCursor() {
    this.cursorHidden = true;
    this.hideTabCursor();
    for (const view of this.host.overlays) {
      const contents = view.webContents;
      contents.insertCSS(CHROME_CURSOR_CSS).then((key) => {
        if (this.cursorHidden) this.chromeKeys.set(contents, key);
        else contents.removeInsertedCSS(key).catch(() => {});
      }).catch(() => {});
    }
  }

  hideTabCursor() {
    const contents = this.tabs.active?.view.webContents;
    if (!contents || contents.isDestroyed()) return;
    this.hiddenTabs.add(contents);
    this.runInFrames(contents, HIDE_CURSOR_SCRIPT);
  }

  showCursor() {
    this.cursorHidden = false;
    for (const contents of this.hiddenTabs) {
      if (!contents.isDestroyed()) this.runInFrames(contents, SHOW_CURSOR_SCRIPT);
    }
    this.hiddenTabs.clear();
    for (const [contents, key] of this.chromeKeys) {
      if (!contents.isDestroyed()) contents.removeInsertedCSS(key).catch(() => {});
    }
    this.chromeKeys.clear();
  }

  runInFrames(contents, script) {
    for (const frame of contents.mainFrame.framesInSubtree) {
      frame.executeJavaScript(script).catch(() => {});
    }
  }
}

module.exports = { FullscreenIdle, DEFAULT_IDLE_MS };
