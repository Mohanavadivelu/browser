'use strict';

// Keyboard shortcuts, handled in the main process because there is no application menu.
function createShortcutHandler({ tabs, host, ui, actions }) {
  return function onBeforeInput(event, input) {
    if (input.type !== 'keyDown') return;
    const ctrl = input.control || input.meta;
    const key = input.key.toLowerCase();
    let handled = true;

    if (input.key === 'F11') host.toggleFullscreen();
    else if (input.key === 'Escape' && host.mode.fullscreen && !host.mode.htmlFullscreen) host.exitFullscreen();
    else if (ctrl && input.shift && key === 'n') tabs.create({ isPrivate: true });
    else if (ctrl && !input.shift && key === 't') tabs.create();
    else if (ctrl && !input.shift && key === 'w') tabs.close(tabs.activeId);
    else if (ctrl && !input.shift && key === 'l') {
      host.setRevealed(true);
      ui.webContents.focus();
      ui.webContents.send('ui:focus-address');
    } else if (ctrl && !input.shift && key === 'd') actions.toggleBookmark();
    else if ((ctrl && !input.shift && key === 'r') || input.key === 'F5') tabs.reload();
    else if (input.alt && input.key === 'ArrowLeft') tabs.back();
    else if (input.alt && input.key === 'ArrowRight') tabs.forward();
    else if (ctrl && input.key === 'Tab') tabs.activateRelative(input.shift ? -1 : 1);
    else handled = false;

    if (handled) event.preventDefault();
  };
}

module.exports = { createShortcutHandler };
