'use strict';

const path = require('node:path');

const BLOCKED_EXTENSIONS = new Set([
  '.exe', '.msi', '.bat', '.cmd', '.com', '.scr', '.ps1', '.psm1', '.vbs', '.vbe',
  '.js', '.jse', '.wsf', '.wsh', '.hta', '.lnk', '.jar', '.reg', '.dll', '.cpl',
  '.msc', '.pif', '.appx', '.msix',
]);

function isDangerousFile(filename) {
  return BLOCKED_EXTENSIONS.has(path.extname(String(filename)).toLowerCase());
}

// Executable downloads are refused; everything else needs an explicit Save dialog.
function attachDownloadPolicy(ses, { onBlocked }) {
  const { app } = require('electron');
  ses.on('will-download', (_event, item) => {
    const filename = item.getFilename();
    if (isDangerousFile(filename)) {
      item.cancel();
      onBlocked?.(filename);
      return;
    }
    item.setSaveDialogOptions({
      title: 'Save download',
      defaultPath: path.join(app.getPath('downloads'), filename),
    });
  });
}

module.exports = { isDangerousFile, attachDownloadPolicy };
