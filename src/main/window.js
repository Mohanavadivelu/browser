'use strict';

const path = require('node:path');
const { EventEmitter } = require('node:events');
const { BaseWindow, WebContentsView } = require('electron');
const { uiPreferences } = require('./sandbox/web-preferences');

const TAB_BAR_HEIGHT = 40;
const TOOLBAR_HEIGHT = 46;
const BOOKMARKS_HEIGHT = 30;
const NORMAL_CHROME_HEIGHT = TAB_BAR_HEIGHT + TOOLBAR_HEIGHT + BOOKMARKS_HEIGHT;
const HOTZONE_HEIGHT = 6;
const INDICATOR_SIZE = { width: 190, height: 34, margin: 8 };
const BACKGROUND = '#1a1b1e';

function lockDown(contents) {
  contents.on('will-navigate', (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

// Owns the window, the browser-chrome view and the layout of tab content around it.
class BrowserWindow extends EventEmitter {
  constructor({ rendererDir, preloadPath }) {
    super();
    this.mode = { fullscreen: false, htmlFullscreen: false, revealed: false, recording: false };
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
    for (const view of [this.ui, this.indicator]) {
      view.setBackgroundColor('#00000000');
      lockDown(view.webContents);
    }
    this.win.contentView.addChildView(this.ui);
    this.win.contentView.addChildView(this.indicator);
    this.indicator.setVisible(false);

    this.ui.webContents.loadFile(path.join(rendererDir, 'index.html'));
    this.indicator.webContents.loadFile(path.join(rendererDir, 'indicator.html'));

    this.win.on('resize', () => this.layout());
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
    const { width, height } = this.win.getContentBounds();
    const { fullscreen, htmlFullscreen, revealed, recording } = this.mode;
    const immersive = fullscreen || htmlFullscreen;

    let uiHeight = NORMAL_CHROME_HEIGHT;
    if (immersive) uiHeight = revealed && !htmlFullscreen ? TOOLBAR_HEIGHT : HOTZONE_HEIGHT;
    this.ui.setVisible(!htmlFullscreen);
    this.ui.setBounds({ x: 0, y: 0, width, height: uiHeight });

    const top = immersive ? 0 : NORMAL_CHROME_HEIGHT;
    for (const view of this.contentViews) {
      view.setBounds({ x: 0, y: top, width, height: Math.max(0, height - top) });
    }

    const showIndicator = recording && immersive && (htmlFullscreen || !revealed);
    this.indicator.setVisible(showIndicator);
    if (showIndicator) {
      this.indicator.setBounds({
        x: Math.max(0, width - INDICATOR_SIZE.width - INDICATOR_SIZE.margin),
        y: INDICATOR_SIZE.margin,
        width: INDICATOR_SIZE.width,
        height: INDICATOR_SIZE.height,
      });
      this.win.contentView.addChildView(this.indicator);
    }
  }
}

module.exports = { BrowserWindow, TOOLBAR_HEIGHT, NORMAL_CHROME_HEIGHT };
