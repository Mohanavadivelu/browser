'use strict';

const { webContents } = require('electron');
const { applyPermissionPolicy } = require('./security/permissions');
const { attachDownloadPolicy } = require('./security/downloads');
const { serveRecordings } = require('./recording/media-server');
const { WEB_FILES, serveAppPages } = require('./app-scheme');

function cleanUserAgent(userAgent) {
  return userAgent.replace(/\s?Electron\/\S+/, '').replace(/\s?simple-browser\/\S+/i, '');
}

// How each session is set up the first time it is used (see SessionManager): the browser's own
// session ('ui') and the web sessions (the regular profile and each private tab's).
// `ctx`: rendererDir, recording (the recording controller), getFolder(), blocker,
// blockingActiveFor(url), getTabs(), downloads, notify, downloadDir, downloadSaveName,
// permissionLog, certificates, cookieClock.
function createSessionSetup(ctx) {
  const { rendererDir, recording, getFolder, blocker, blockingActiveFor, getTabs, downloads, notify, permissionLog, certificates, cookieClock } = ctx;

  return (ses, kind) => {
    if (kind === 'ui') {
      // The browser's own views may ask for screen capture (granted only to the toolbar, right
      // after the consent dialog) and, while narrating, the microphone.
      applyPermissionPolicy(ses, new Set(['display-capture']), { allowMicrophone: recording.allowMicrophone });
      // Recordings and screenshots for the Recordings page's player; web sessions never get this.
      serveRecordings(ses, getFolder);
      ses.setDisplayMediaRequestHandler((request, callback) => {
        const requester = request.frame ? webContents.fromFrame(request.frame) : null;
        recording.handleDisplayMedia(requester, callback);
      }, { useSystemPicker: false });
      return;
    }
    applyPermissionPolicy(ses, undefined, { onRequest: (contents, permission, granted) => permissionLog?.record(contents.id, permission, granted) });
    // The certificate each site presents, for the site info panel; Chromium still decides (-3).
    ses.setCertificateVerifyProc((request, callback) => {
      certificates?.record(ses, request);
      callback(-3);
    });
    // When each cookie of the regular profile was set, for clearing a time range (never kept
    // for private tabs, which keep nothing).
    if (kind === 'web') cookieClock?.attach(ses);
    // Web tabs show the new tab page, the certificate warning and the crash page, and nothing
    // else of the app.
    serveAppPages(ses, rendererDir, WEB_FILES);
    blocker.attach(ses, {
      pageUrlOf: (details) => {
        const contents = details.webContentsId ? webContents.fromId(details.webContentsId) : null;
        return contents && !contents.isDestroyed() ? contents.getURL() : '';
      },
      isActive: blockingActiveFor,
      onBlocked: (contentsId, request) => getTabs().countBlocked(contentsId, request),
    });
    // Downloads from private tabs are listed while the browser runs, but never saved.
    const isPrivate = kind === 'private';
    attachDownloadPolicy(ses, {
      onBlocked: (name) => notify(`Blocked download of "${name}": executable files are not allowed.`, 'warning'),
      onStart: (item) => downloads.track(item, { isPrivate, session: ses }),
      presetPath: (item) => downloads.presetPath(item),
      autoSaveDir: ctx.downloadDir,
      saveName: ctx.downloadSaveName,
    });
    ses.setUserAgent(cleanUserAgent(ses.getUserAgent()));
  };
}

module.exports = { createSessionSetup, cleanUserAgent };
