'use strict';

// Whether a view's page can still be sent to. A view loses its webContents altogether once the
// window it was in has closed, so `view.webContents.isDestroyed()` alone can throw then (as the
// browser quits, while downloads still report progress, say).
const isLive = (contents) => Boolean(contents) && !contents.isDestroyed();

module.exports = { isLive };
