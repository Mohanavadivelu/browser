'use strict';

// Only these permissions are ever granted to web content; everything else is denied.
const WEB_ALLOWED = new Set(['fullscreen', 'clipboard-sanitized-write']);

function isPermissionAllowed(permission, allowed = WEB_ALLOWED) {
  return allowed.has(permission);
}

function applyPermissionPolicy(ses, allowed = WEB_ALLOWED) {
  ses.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(isPermissionAllowed(permission, allowed));
  });
  ses.setPermissionCheckHandler((_contents, permission) => isPermissionAllowed(permission, allowed));
  ses.setDevicePermissionHandler(() => false);
}

module.exports = { WEB_ALLOWED, isPermissionAllowed, applyPermissionPolicy };
