'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { applyPermissionPolicy, isMicrophoneOnly } = require('../../src/main/security/permissions');
const { consentDialogOptions } = require('../../src/main/recording/consent');
const { sanitizeSettings } = require('../../src/main/storage/settings');

// A session whose permission handlers can be asked directly.
function session() {
  const handlers = {};
  return {
    handlers,
    setPermissionRequestHandler: (fn) => { handlers.request = fn; },
    setPermissionCheckHandler: (fn) => { handlers.check = fn; },
    setDevicePermissionHandler: (fn) => { handlers.device = fn; },
  };
}
const ask = (ses, contents, permission, details) => {
  let answer;
  ses.handlers.request(contents, permission, (granted) => { answer = granted; }, details);
  return answer;
};

test('only a request for the microphone alone counts as one', () => {
  assert.equal(isMicrophoneOnly('media', { mediaTypes: ['audio'] }), true);
  assert.equal(isMicrophoneOnly('media', { mediaTypes: ['audio', 'video'] }), false);
  assert.equal(isMicrophoneOnly('media', { mediaTypes: ['video'] }), false);
  assert.equal(isMicrophoneOnly('media', { mediaTypes: [] }), false);
  assert.equal(isMicrophoneOnly('media', { mediaType: 'audio' }), true, 'a permission check');
  assert.equal(isMicrophoneOnly('media', { mediaType: 'video' }), false);
  assert.equal(isMicrophoneOnly('geolocation', { mediaTypes: ['audio'] }), false);
});

test('the microphone goes only where the policy allows it, and never with the camera', () => {
  const toolbar = { id: 1 };
  const other = { id: 2 };
  let narrating = true;
  const ses = session();
  applyPermissionPolicy(ses, new Set(['display-capture']), { allowMicrophone: (contents) => contents === toolbar && narrating });
  assert.equal(ask(ses, toolbar, 'media', { mediaTypes: ['audio'] }), true);
  assert.equal(ses.handlers.check(toolbar, 'media', 'file://', { mediaType: 'audio' }), true);
  assert.equal(ask(ses, toolbar, 'media', { mediaTypes: ['audio', 'video'] }), false, 'not the camera');
  assert.equal(ask(ses, other, 'media', { mediaTypes: ['audio'] }), false, 'not another page');
  assert.equal(ask(ses, toolbar, 'display-capture', {}), true);
  narrating = false;
  assert.equal(ask(ses, toolbar, 'media', { mediaTypes: ['audio'] }), false, 'not when narration is off or nothing is recording');
});

test('web sessions never get the microphone', () => {
  const ses = session();
  applyPermissionPolicy(ses);
  assert.equal(ask(ses, { id: 3 }, 'media', { mediaTypes: ['audio'] }), false);
  assert.equal(ses.handlers.check({ id: 3 }, 'media', 'https://a.example', { mediaType: 'audio' }), false);
  assert.equal(ask(ses, { id: 3 }, 'fullscreen', {}), true);
});

test('narration is off by default, and the consent dialog says when it is on', () => {
  assert.equal(sanitizeSettings({}).recordingMicrophone, false);
  assert.equal(sanitizeSettings({ recordingMicrophone: 'yes' }).recordingMicrophone, false);
  assert.equal(sanitizeSettings({ recordingMicrophone: true }).recordingMicrophone, true);
  assert.doesNotMatch(consentDialogOptions().detail, /microphone/);
  assert.match(consentDialogOptions({ microphone: true }).detail, /Your microphone is recorded too/);
  assert.equal(consentDialogOptions({ microphone: true }).checkboxLabel, 'I have permission to record this content');
});
