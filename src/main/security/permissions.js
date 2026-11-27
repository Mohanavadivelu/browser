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
// `onRequest(contents, permission, granted)` hears each request a page makes, and the answer (the
// site info panel lists them).
function applyPermissionPolicy(ses, allowed = WEB_ALLOWED, { allowMicrophone = () => false, onRequest = null } = {}) {
  const decide = (contents, permission, details) => isPermissionAllowed(permission, allowed) ||
    (isMicrophoneOnly(permission, details) && Boolean(allowMicrophone(contents)));
  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    const granted = decide(contents, permission, details);
    callback(granted);
    if (contents && onRequest) {
      try {
        onRequest(contents, permission, granted);
      } catch {
        // Listing it must never get in the way of the answer.
      }
    }
  });
  ses.setPermissionCheckHandler((contents, permission, _origin, details) => decide(contents, permission, details));
  ses.setDevicePermissionHandler(() => false);
}

module.exports = { WEB_ALLOWED, isPermissionAllowed, isMicrophoneOnly, applyPermissionPolicy };
