'use strict';

const { dialog } = require('electron');

// What the consent dialog says; with narration on, it also says the microphone is recorded.
function consentDialogOptions({ microphone = false } = {}) {
  return {
    type: 'warning',
    title: 'Record this page?',
    message: 'Record this page?',
    detail:
      'Recording captures the current tab\'s page and its sound, not the browser bars or other apps. ' +
      (microphone ? 'Your microphone is recorded too (narration is on in Settings). ' : '') +
      'Only record content you own or have permission to record, and respect other people\'s ' +
      'privacy and the website\'s terms. A recording indicator stays visible while recording.',
    buttons: ['Start recording', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    checkboxLabel: 'I have permission to record this content',
    checkboxChecked: false,
  };
}

// Native dialog, so web content can never fake or skip the consent step.
async function askRecordingConsent(win, options) {
  const { response, checkboxChecked } = await dialog.showMessageBox(win, consentDialogOptions(options));
  if (response !== 0) return { granted: false };
  return checkboxChecked ? { granted: true } : { granted: false, reason: 'unchecked' };
}

module.exports = { askRecordingConsent, consentDialogOptions };
