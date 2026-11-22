'use strict';

const baseWebPreferences = Object.freeze({
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
  experimentalFeatures: false,
  safeDialogs: true,
});

// Web pages get no preload script at all, so they have no bridge into the app.
function contentPreferences(partition) {
  return { ...baseWebPreferences, partition, spellcheck: true };
}

function uiPreferences(preloadPath) {
  return { ...baseWebPreferences, partition: 'ui', preload: preloadPath, spellcheck: false };
}

module.exports = { baseWebPreferences, contentPreferences, uiPreferences };
