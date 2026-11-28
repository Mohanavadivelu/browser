'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pdfFileName } = require('../recording/library');
const { saveScreenshot } = require('../recording/storage');

// The tallest full-page screenshot, in CSS pixels (taller pages are cut there).
const MAX_FULL_HEIGHT = 16000;

// What the shortcuts and the main menu do to the current page: zoom, find, print, save as PDF,
// screenshot, and opening the browser's own pages. `ctx` holds tabs, host, zoom, dialog, win,
// documentsDir(), getRecordingFolder(), notify, pushState, broadcastToLibrary.
function createPageActions(ctx) {
  const { tabs, host, zoom, dialog, win, documentsDir, getRecordingFolder, notify, pushState, broadcastToLibrary } = ctx;

  // The active tab when it is a web page (not one of the browser's own pages), else null.
  const webTab = () => (tabs.active?.kind === 'web' ? tabs.active : null);

  return {
    zoom: (direction) => {
      const tab = webTab();
      if (!tab) return;
      const factor = zoom.change(tab, direction);
      if (factor === null) return;
      pushState();
      notify(`Zoom ${Math.round(factor * 100)}%`);
    },

    find: () => host.openFind(),

    openLibrary: (page) => tabs.openInternal(page),

    // The system print dialog for the current page.
    print: () => {
      const tab = webTab();
      if (!tab) return;
      tab.view.webContents.print({}, (success, reason) => {
        if (!success && reason !== 'cancelled' && reason !== 'Print job canceled') notify(`Could not print: ${reason}`, 'error');
      });
    },

    // Saves the current page as a PDF, named after its title.
    savePdf: async () => {
      const tab = webTab();
      if (!tab) return null;
      const result = await dialog.showSaveDialog(win, {
        title: 'Save page as PDF',
        defaultPath: path.join(documentsDir(), pdfFileName(tab.title)),
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
      });
      if (result.canceled || !result.filePath) return null;
      try {
        const pdf = await tab.view.webContents.printToPDF({ printBackground: true });
        fs.writeFileSync(result.filePath, pdf);
      } catch (error) {
        notify(`Could not save the PDF: ${error.message}`, 'error');
        return null;
      }
      notify(`Saved PDF: ${result.filePath}`);
      return result.filePath;
    },

    // A PNG of the whole page, top to bottom, through Chromium's own screenshot command (the
    // DevTools protocol, attached only for this). Very long pages are cut at MAX_FULL_HEIGHT.
    fullScreenshot: async () => {
      const tab = tabs.active;
      if (tab?.kind !== 'web') return null;
      const contents = tab.view.webContents;
      const devtools = contents.debugger;
      const attachedBefore = devtools.isAttached();
      try {
        if (!attachedBefore) devtools.attach('1.3');
        const metrics = await devtools.sendCommand('Page.getLayoutMetrics');
        const size = metrics.cssContentSize ?? metrics.contentSize;
        const width = Math.max(1, Math.ceil(size.width));
        const fullHeight = Math.max(1, Math.ceil(size.height));
        const height = Math.min(fullHeight, MAX_FULL_HEIGHT);
        const shot = await devtools.sendCommand('Page.captureScreenshot', {
          format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height, scale: 1 },
        });
        const filePath = saveScreenshot(getRecordingFolder(), Buffer.from(shot.data, 'base64'));
        notify(fullHeight > height
          ? `Screenshot saved (the page is very long: its first ${MAX_FULL_HEIGHT.toLocaleString()} pixels): ${filePath}`
          : `Full-page screenshot saved: ${filePath}`);
        broadcastToLibrary('recordings:changed');
        return filePath;
      } catch (error) {
        notify(`Could not capture the whole page: ${error.message}`, 'error');
        return null;
      } finally {
        if (!attachedBefore && devtools.isAttached()) devtools.detach();
      }
    },

    // A PNG of the visible page, saved with the recordings.
    screenshot: async () => {
      const tab = tabs.active;
      if (!tab) return null;
      try {
        const image = await tab.view.webContents.capturePage();
        if (image.isEmpty()) throw new Error('The page is not visible.');
        const filePath = saveScreenshot(getRecordingFolder(), image.toPNG());
        notify(`Screenshot saved: ${filePath}`);
        broadcastToLibrary('recordings:changed');
        return filePath;
      } catch (error) {
        notify(`Could not capture a screenshot: ${error.message}`, 'error');
        return null;
      }
    },
  };
}

module.exports = { createPageActions };
