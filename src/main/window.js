'use strict';

const { EventEmitter } = require('node:events');
const { BaseWindow, WebContentsView } = require('electron');
const { uiPreferences } = require('./sandbox/web-preferences');
const { appUrl } = require('./app-scheme');

const TAB_BAR_HEIGHT = 40;
const TOOLBAR_HEIGHT = 46;
const BOOKMARKS_HEIGHT = 30;
const NORMAL_CHROME_HEIGHT = TAB_BAR_HEIGHT + TOOLBAR_HEIGHT + BOOKMARKS_HEIGHT;
const HOTZONE_HEIGHT = 6;
const INDICATOR_SIZE = { width: 320, height: 34, margin: 8 };
const FIND_SIZE = { width: 380, height: 46 };
const BACKGROUND = '#1a1b1e';

function lockDown(contents) {
  contents.on('will-navigate', (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

// Owns the window, the browser-chrome views and the layout of tab content around them.
class BrowserWindow extends EventEmitter {
  constructor({ preloadPath }) {
    super();
    this.mode = {
      fullscreen: false, htmlFullscreen: false, revealed: false, recording: false, findOpen: false, suggestionsHeight: 0,
      bookmarksBar: true,
    };
    this.contentViews = new Set();
    this.enteredFullscreenForHtml = false;

    this.win = new BaseWindow({
      width: 1280,
      height: 800,
      minWidth: 640,
      minHeight: 480,
      title: 'Simple Browser',
      backgroundColor: BACKGROUND,
      show: false,
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: BACKGROUND, symbolColor: '#e8eaed', height: TAB_BAR_HEIGHT },
    });

    this.ui = new WebContentsView({ webPreferences: uiPreferences(preloadPath) });
    this.indicator = new WebContentsView({ webPreferences: uiPreferences(preloadPath) });
    this.find = new WebContentsView({ webPreferences: uiPreferences(preloadPath) });
    this.overlays = [this.ui, this.indicator, this.find];
    for (const view of this.overlays) {
      view.setBackgroundColor('#00000000');
      lockDown(view.webContents);
      this.win.contentView.addChildView(view);
    }
    this.indicator.setVisible(false);
    this.find.setVisible(false);

    this.ui.webContents.loadURL(appUrl('index.html'));
    this.indicator.webContents.loadURL(appUrl('indicator.html'));
    this.find.webContents.loadURL(appUrl('find.html'));

    this.win.on('resize', () => this.layout());
    // A minimized window reports no size; lay the views out again as soon as it is back.
    for (const name of ['restore', 'show', 'maximize', 'unmaximize']) this.win.on(name, () => this.layout());
    this.win.on('enter-full-screen', () => this.setFullscreenState(true));
    this.win.on('leave-full-screen', () => this.setFullscreenState(false));
  }

  addContentView(view) {
    this.contentViews.add(view);
    this.win.contentView.addChildView(view, 0);
    this.layout();
  }

  removeContentView(view) {
    this.contentViews.delete(view);
    this.win.contentView.removeChildView(view);
  }

  setFullscreenState(on) {
    this.mode.fullscreen = on;
    this.mode.revealed = false;
    if (!on) this.mode.htmlFullscreen = false;
    this.layout();
    this.emit('mode-change');
  }

  toggleFullscreen() {
    this.win.setFullScreen(!this.win.isFullScreen());
  }

  exitFullscreen() {
    if (this.win.isFullScreen()) this.win.setFullScreen(false);
  }

  setRevealed(revealed) {
    if (!this.mode.fullscreen || this.mode.revealed === revealed) return;
    this.mode.revealed = revealed;
    this.layout();
    this.emit('mode-change');
  }

  setRecording(recording) {
    this.mode.recording = recording;
    this.layout();
  }

  // Height of the tab strip, toolbar and (when shown) bookmarks bar.
  chromeHeight() {
    return TAB_BAR_HEIGHT + TOOLBAR_HEIGHT + (this.mode.bookmarksBar ? BOOKMARKS_HEIGHT : 0);
  }

  setBookmarksBar(shown) {
    if (this.mode.bookmarksBar === shown) return;
    this.mode.bookmarksBar = shown;
    this.layout();
  }

  // Extra height for the toolbar's view while the address-bar suggestions, the star's popover or
  // a bookmarks menu is open. Returns the height of the window's content, so a menu knows how
  // far down it can reach.
  setSuggestionsHeight(height) {
    if (this.mode.suggestionsHeight !== height) {
      this.mode.suggestionsHeight = height;
      this.layout();
    }
    return this.win.isDestroyed() ? 0 : this.win.getContentBounds().height;
  }

  openFind() {
    if (!this.mode.findOpen) {
      this.mode.findOpen = true;
      this.layout();
      this.emit('find-change', true);
    }
    this.find.webContents.focus();
    this.find.webContents.send('find:focus');
  }

  closeFind() {
    if (!this.mode.findOpen) return;
    this.mode.findOpen = false;
    this.layout();
    this.emit('find-change', false);
  }

  // A page asked for HTML5 fullscreen (e.g. a video player): fill the whole window.
  setHtmlFullscreen(on) {
    if (this.mode.htmlFullscreen === on) return;
    this.mode.htmlFullscreen = on;
    if (on && !this.win.isFullScreen()) {
      this.enteredFullscreenForHtml = true;
      this.win.setFullScreen(true);
    } else if (!on && this.enteredFullscreenForHtml) {
      this.enteredFullscreenForHtml = false;
      this.win.setFullScreen(false);
    }
    this.layout();
    this.emit('mode-change');
  }

  layout() {
    // Views and timers can still ask for a layout after the window was closed.
    if (this.win.isDestroyed()) return;
    const { width, height } = this.win.getContentBounds();
    // A minimized window has no size; keep the previous layout until it is restored.
    if (width <= 0 || height <= 0) return;
    const { fullscreen, htmlFullscreen, revealed, recording, findOpen } = this.mode;
    const immersive = fullscreen || htmlFullscreen;

    const chromeHeight = this.chromeHeight();
    let uiHeight = chromeHeight;
    if (immersive) uiHeight = revealed && !htmlFullscreen ? TOOLBAR_HEIGHT : HOTZONE_HEIGHT;
    // The suggestion list hangs below the address bar, over the page.
    if (!htmlFullscreen && (!immersive || revealed)) uiHeight += this.mode.suggestionsHeight;
    this.ui.setVisible(!htmlFullscreen);
    this.ui.setBounds({ x: 0, y: 0, width, height: uiHeight });

    const top = immersive ? 0 : chromeHeight;
    for (const view of this.contentViews) {
      view.setBounds({ x: 0, y: top, width, height: Math.max(0, height - top) });
    }

    const showIndicator = recording && immersive && (htmlFullscreen || !revealed);
    this.indicator.setVisible(showIndicator);
    let overlayRight = width - 12;
    if (showIndicator) {
      const indicatorX = Math.max(0, width - INDICATOR_SIZE.width - INDICATOR_SIZE.margin);
      this.indicator.setBounds({
        x: indicatorX,
        y: INDICATOR_SIZE.margin,
        width: INDICATOR_SIZE.width,
        height: INDICATOR_SIZE.height,
      });
      this.win.contentView.addChildView(this.indicator);
      overlayRight = indicatorX - 8;
    }

    // The find bar floats at the top right of the page, beside the REC indicator if it is showing.
    this.find.setVisible(findOpen);
    if (findOpen) {
      let findTop = chromeHeight + 8;
      if (immersive) findTop = revealed && !htmlFullscreen ? TOOLBAR_HEIGHT + 8 : 8;
      this.find.setBounds({
        x: Math.max(0, overlayRight - FIND_SIZE.width),
        y: findTop,
        width: FIND_SIZE.width,
        height: FIND_SIZE.height,
      });
      this.win.contentView.addChildView(this.find);
    }
  }
}

module.exports = { BrowserWindow, TOOLBAR_HEIGHT, NORMAL_CHROME_HEIGHT };
