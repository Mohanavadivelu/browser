'use strict';

const { session } = require('electron');

const REGULAR_PARTITION = 'persist:browsing';
const UI_PARTITION = 'ui';

// Regular tabs share one saved profile; each private tab gets its own in-memory session
// that is wiped when the tab closes.
class SessionManager {
  constructor(configure) {
    this.configure = configure;
    this.configured = new Set();
  }

  partitionFor(tabId, isPrivate) {
    return isPrivate ? `private-${tabId}` : REGULAR_PARTITION;
  }

  ensure(partition, kind = 'web') {
    const ses = session.fromPartition(partition);
    if (!this.configured.has(partition)) {
      this.configured.add(partition);
      this.configure(ses, kind);
    }
    return ses;
  }

  async releasePrivate(tabId) {
    const partition = this.partitionFor(tabId, true);
    if (!this.configured.has(partition)) return;
    const ses = session.fromPartition(partition);
    await ses.closeAllConnections();
    await ses.clearStorageData();
    await ses.clearCache();
    await ses.clearAuthCache();
    this.configured.delete(partition);
  }
}

module.exports = { SessionManager, REGULAR_PARTITION, UI_PARTITION };
