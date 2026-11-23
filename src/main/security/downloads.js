'use strict';

const fs = require('node:fs');
const path = require('node:path');

// File types Windows can run, install, mount or open as a shortcut. Downloads with these
// extensions are refused, whether the name came from the website or from the Save dialog.
const BLOCKED_EXTENSIONS = new Set([
  // Programs and installers
  '.exe', '.com', '.scr', '.pif', '.msi', '.msp', '.mst', '.dll', '.cpl', '.msc', '.jar', '.jnlp',
  '.appx', '.appxbundle', '.msix', '.msixbundle', '.appinstaller', '.application', '.appref-ms',
  '.gadget', '.xll',
  // Scripts
  '.bat', '.cmd', '.ps1', '.ps1xml', '.ps2', '.psc1', '.psd1', '.psm1', '.vb', '.vbs', '.vbe',
  '.js', '.jse', '.wsf', '.wsh', '.ws', '.wsc', '.sct', '.hta', '.reg', '.inf', '.ins', '.isp',
  // Shortcuts and shell files that point at or launch other programs
  '.lnk', '.url', '.scf', '.shb', '.library-ms', '.search-ms', '.searchconnector-ms',
  '.settingcontent-ms', '.diagcab',
  // Containers Windows opens without a warning on the files inside
  '.iso', '.img', '.vhd', '.vhdx', '.cab', '.chm',
]);

// Windows drops trailing dots and spaces, so "setup.exe. " is saved as "setup.exe".
function isDangerousFile(filename) {
  const name = path.win32.basename(String(filename)).replace(/[. ]+$/, '');
  return BLOCKED_EXTENSIONS.has(path.win32.extname(name).toLowerCase());
}

const removeFile = (filePath) => fs.rmSync(filePath, { force: true });

// Applies the policy to one download. Returns false if it was refused at once.
// The user can change the name in the Save dialog, so the chosen path is checked again while
// the download runs and once more when it finishes. A blocked item emits 'blocked'.
// `autoSaveDir` and `saveName` skip the dialog and are only used by automated tests.
function guardDownload(item, { onBlocked, onStart, autoSaveDir, saveName, defaultDir, remove = removeFile }) {
  const filename = item.getFilename();
  if (isDangerousFile(filename)) {
    item.cancel();
    onBlocked?.(filename);
    return false;
  }
  if (autoSaveDir) {
    item.setSavePath(path.join(autoSaveDir, saveName?.(filename) ?? path.basename(filename)));
  } else {
    item.setSaveDialogOptions({ title: 'Save download', defaultPath: path.join(defaultDir, filename) });
  }

  let blocked = false;
  const block = (savePath) => {
    blocked = true;
    item.emit('blocked');
    onBlocked?.(path.win32.basename(savePath));
  };
  item.on('updated', () => {
    const savePath = item.getSavePath();
    if (blocked || !savePath || !isDangerousFile(savePath)) return;
    block(savePath);
    // Cancelling from inside the item's own event re-enters Chromium's observer list.
    setImmediate(() => item.cancel());
  });
  // A small file can finish before any update arrives; delete it if its name is blocked.
  item.once('done', (_event, state) => {
    const savePath = item.getSavePath();
    if (state !== 'completed' || !savePath || !isDangerousFile(savePath)) return;
    if (!blocked) block(savePath);
    try {
      remove(savePath);
    } catch (error) {
      console.error(`Could not remove the blocked download: ${error.message}`);
    }
  });

  onStart?.(item);
  return true;
}

function attachDownloadPolicy(ses, { onBlocked, onStart, autoSaveDir, saveName }) {
  const { app } = require('electron');
  ses.on('will-download', (_event, item) => {
    guardDownload(item, { onBlocked, onStart, autoSaveDir, saveName, defaultDir: app.getPath('downloads') });
  });
}

module.exports = { BLOCKED_EXTENSIONS, isDangerousFile, guardDownload, attachDownloadPolicy };
