'use strict';

// Keyboard shortcuts, handled in the main process because there is no application menu.
// `source` is the web contents the key was pressed in.
function createShortcutHandler({ tabs, host, ui, actions }) {
  return function onBeforeInput(event, input, source) {
    if (input.type !== 'keyDown') return;
    const ctrl = input.control || input.meta;
    const key = input.key.toLowerCase();
    const inPage = Boolean(source) && source === tabs.active?.view.webContents;
    // In full screen a page gets Esc for itself (to close its own pop-ups, say); holding Esc,
    // or pressing it in the browser's own bars, leaves full screen. F11 always does.
    const escapeLeavesFullscreen = !inPage || input.isAutoRepeat;
    let handled = true;

    if (input.key === 'F11') host.toggleFullscreen();
    else if (input.key === 'Escape' && host.mode.findOpen) host.closeFind();
    // Esc in the address bar closes its suggestion list first.
    else if (input.key === 'Escape' && host.mode.suggestionsHeight > 0 && !inPage) handled = false;
    else if (input.key === 'Escape' && host.mode.fullscreen && !host.mode.htmlFullscreen && escapeLeavesFullscreen) host.exitFullscreen();
    else if (ctrl && input.shift && key === 'n') tabs.create({ isPrivate: true });
    else if (ctrl && input.shift && key === 'a') {
      // Search the open tabs: a list in the toolbar, which takes the keyboard.
      host.setRevealed(true);
      ui.webContents.focus();
      ui.webContents.send('ui:tab-search');
    }
    else if (ctrl && input.shift && key === 't') tabs.reopenClosed();
    else if (ctrl && input.shift && key === 'o') actions.openLibrary('bookmarks');
    else if (ctrl && input.shift && key === 'b') actions.toggleBookmarksBar();
    else if (ctrl && input.shift && key === 'e') actions.toggleRecording();
    else if (ctrl && input.shift && key === 'm') actions.addMarker();
    else if ((ctrl && input.shift && key === 'r') || (ctrl && input.key === 'F5')) tabs.reloadIgnoringCache();
    else if (ctrl && input.shift && key === 'p') actions.togglePause();
    else if (ctrl && input.shift && key === 's') actions.screenshot();
    else if (ctrl && input.shift && key === 'f') actions.fullScreenshot();
    // A new tab beside this one, as a split.
    else if (ctrl && input.shift && key === 'l') actions.splitWithNewTab();
    else if (ctrl && !input.shift && key === 't') tabs.create();
    // A pinned tab isn't closed by the shortcut (closed by accident, it would be gone for good):
    // its right-click menu closes it.
    else if (ctrl && !input.shift && key === 'w') {
      if (tabs.active?.pinned) actions.notify?.('Pinned tabs close from their right-click menu.');
      else tabs.close(tabs.activeId);
    }
    else if (ctrl && !input.shift && key === 'f') actions.find();
    else if (ctrl && !input.shift && key === 'p') actions.print();
    else if (ctrl && !input.shift && key === 'h') actions.openLibrary('history');
    else if (ctrl && !input.shift && key === 'j') actions.openLibrary('downloads');
    else if (ctrl && !input.alt && (input.key === '+' || input.key === '=')) actions.zoom(1);
    else if (ctrl && !input.alt && (input.key === '-' || input.key === '_')) actions.zoom(-1);
    else if (ctrl && !input.alt && input.key === '0') actions.zoom(0);
    else if (ctrl && !input.shift && key === 'l') {
      host.setRevealed(true);
      ui.webContents.focus();
      ui.webContents.send('ui:focus-address');
    } else if (ctrl && !input.shift && key === 'd') actions.openStar();
    else if ((ctrl && !input.shift && key === 'r') || input.key === 'F5') tabs.reload();
    else if (input.alt && input.key === 'ArrowLeft') tabs.back();
    else if (input.alt && input.key === 'ArrowRight') tabs.forward();
    else if (ctrl && input.key === 'Tab') tabs.activateRelative(input.shift ? -1 : 1);
    else handled = false;

    if (handled) event.preventDefault();
  };
}

module.exports = { createShortcutHandler };
