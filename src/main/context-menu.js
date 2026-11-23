'use strict';

const { isAllowedUrl, engineFor } = require('./security/navigation');

const MAX_LABEL_TEXT = 30;

function trimSeparators(items) {
  const result = [];
  for (const item of items) {
    if (item.type === 'separator' && (result.length === 0 || result.at(-1).type === 'separator')) continue;
    result.push(item);
  }
  if (result.at(-1)?.type === 'separator') result.pop();
  return result;
}

// Builds the right-click menu for a page. `actions` does the work; only http(s) links and
// images are ever offered, so a page cannot place a dangerous address in the menu.
function buildContextMenuTemplate(params, actions) {
  const items = [];
  const separator = () => items.push({ type: 'separator' });
  const flags = params.editFlags ?? {};

  const link = params.linkURL && isAllowedUrl(params.linkURL) ? params.linkURL : '';
  if (link) {
    items.push(
      { label: 'Open link in new tab', click: () => actions.openInNewTab(link) },
      { label: 'Copy link address', click: () => actions.copyText(link) },
    );
    separator();
  }

  const image = params.mediaType === 'image' && params.srcURL && isAllowedUrl(params.srcURL) ? params.srcURL : '';
  if (image) {
    items.push(
      { label: 'Save image as…', click: () => actions.saveImage(image) },
      { label: 'Copy image', click: () => actions.copyImage(params.x, params.y) },
      { label: 'Copy image address', click: () => actions.copyText(image) },
    );
    separator();
  }

  if (params.isEditable) {
    items.push(
      { label: 'Cut', enabled: flags.canCut !== false, click: () => actions.edit('cut') },
      { label: 'Copy', enabled: flags.canCopy !== false, click: () => actions.edit('copy') },
      { label: 'Paste', enabled: flags.canPaste !== false, click: () => actions.edit('paste') },
      { label: 'Select all', enabled: flags.canSelectAll !== false, click: () => actions.edit('selectAll') },
    );
  } else if (params.selectionText?.trim()) {
    const text = params.selectionText.trim();
    const short = text.length > MAX_LABEL_TEXT ? `${text.slice(0, MAX_LABEL_TEXT)}…` : text;
    items.push(
      { label: 'Copy', click: () => actions.edit('copy') },
      { label: `Search ${engineFor(actions.searchEngine?.()).name} for “${short}”`, click: () => actions.searchFor(text) },
    );
  }

  if (!params.isEditable && actions.navigation) {
    separator();
    const nav = actions.navigation;
    items.push(
      { label: 'Back', enabled: nav.canGoBack(), click: () => nav.back() },
      { label: 'Forward', enabled: nav.canGoForward(), click: () => nav.forward() },
      { label: 'Reload', click: () => nav.reload() },
    );
  }
  return trimSeparators(items);
}

// Shows the menu for a page or for the browser's own text boxes.
function attachContextMenu(contents, win, makeActions) {
  const { Menu } = require('electron');
  contents.on('context-menu', (_event, params) => {
    const template = buildContextMenuTemplate(params, makeActions(contents));
    if (template.length === 0) return;
    Menu.buildFromTemplate(template).popup({ window: win });
  });
}

module.exports = { buildContextMenuTemplate, attachContextMenu };
