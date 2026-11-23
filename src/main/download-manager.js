'use strict';

const { EventEmitter } = require('node:events');

const MAX_TRACKED = 50;

// Tracks downloads for this session so the Downloads page can show progress.
class DownloadManager extends EventEmitter {
  constructor() {
    super();
    this.items = new Map();
    this.nextId = 1;
  }

  track(item) {
    const id = this.nextId++;
    const entry = {
      id,
      filename: item.getFilename(),
      path: '',
      received: 0,
      total: item.getTotalBytes(),
      state: 'progressing',
      startedAt: Date.now(),
    };
    this.items.set(id, { entry, item });

    item.on('updated', (_event, state) => {
      entry.received = item.getReceivedBytes();
      entry.total = item.getTotalBytes();
      entry.path = item.getSavePath() || entry.path;
      entry.state = state === 'interrupted' ? 'interrupted' : item.isPaused() ? 'paused' : 'progressing';
      this.emit('change');
    });
    item.once('done', (_event, state) => {
      entry.received = item.getReceivedBytes();
      entry.path = item.getSavePath() || entry.path;
      entry.state = state;
      this.emit('change');
      if (state === 'completed') this.emit('completed', { ...entry });
    });

    this.trim();
    this.emit('started', { ...entry });
    this.emit('change');
    return id;
  }

  trim() {
    if (this.items.size <= MAX_TRACKED) return;
    for (const [id, { entry }] of this.items) {
      if (this.items.size <= MAX_TRACKED) break;
      if (entry.state !== 'progressing' && entry.state !== 'paused') this.items.delete(id);
    }
  }

  list() {
    return [...this.items.values()].map(({ entry }) => ({ ...entry })).reverse();
  }

  cancel(id) {
    const found = this.items.get(id);
    if (!found || !['progressing', 'paused'].includes(found.entry.state)) return false;
    found.item.cancel();
    return true;
  }

  pathOf(id) {
    return this.items.get(id)?.entry.path || '';
  }
}

module.exports = { DownloadManager };
