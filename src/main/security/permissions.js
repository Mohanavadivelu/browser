'use strict';

// Only these permissions are ever granted to web content; everything else is denied.
const WEB_ALLOWED = new Set(['fullscreen', 'clipboard-sanitized-write']);

function isPermissionAllowed(permission, allowed = WEB_ALLOWED) {
  return allowed.has(permission);
}

// A request (or check) for the microphone alone: never the camera, never both.
function isMicrophoneOnly(permission, details = {}) {
  if (permission !== 'media') return false;
  if (Array.isArray(details.mediaTypes)) return details.mediaTypes.length > 0 && details.mediaTypes.every((type) => type === 'audio');
  return details.mediaType === 'audio';
}

// `allowMicrophone(contents)` may grant the microphone (audio only) to particular pages: the
// browser's own toolbar, while a recording with narration is running. Web sessions never pass it.
function applyPermissionPolicy(ses, allowed = WEB_ALLOWED, { allowMicrophone = () => false } = {}) {
  const decide = (contents, permission, details) => isPermissionAllowed(permission, allowed) ||
    (isMicrophoneOnly(permission, details) && Boolean(allowMicrophone(contents)));
  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(decide(contents, permission, details));
  });
  ses.setPermissionCheckHandler((contents, permission, _origin, details) => decide(contents, permission, details));
  ses.setDevicePermissionHandler(() => false);
}

module.exports = { WEB_ALLOWED, isPermissionAllowed, isMicrophoneOnly, applyPermissionPolicy };
