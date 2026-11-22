'use strict';

const { dialog } = require('electron');

// Native dialog, so web content can never fake or skip the consent step.
async function askRecordingConsent(win) {
  const { response, checkboxChecked } = await dialog.showMessageBox(win, {
    type: 'warning',
    title: 'Record this page?',
    message: 'Record this page?',
    detail:
      'Recording captures the current tab\'s page and its sound, not the browser bars or other apps. ' +
      'Only record content you own or have permission to record, and respect other people\'s ' +
      'privacy and the website\'s terms. A recording indicator stays visible while recording.',
    buttons: ['Start recording', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    checkboxLabel: 'I have permission to record this content',
    checkboxChecked: false,
  });
  if (response !== 0) return { granted: false };
  return checkboxChecked ? { granted: true } : { granted: false, reason: 'unchecked' };
}

module.exports = { askRecordingConsent };
