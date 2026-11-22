'use strict';

// Chromium net error codes for certificate problems (ERR_CERT_*) and ERR_INSECURE_RESPONSE.
function isCertificateError(code) {
  return (code <= -200 && code >= -219) || code === -501;
}

module.exports = { isCertificateError };
