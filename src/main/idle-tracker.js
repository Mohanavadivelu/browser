'use strict';

// Tracks user inactivity with an injectable clock so the timing logic is easy to test.
class IdleTracker {
  constructor({ idleMs, now = Date.now, onIdle, onActive }) {
    this.idleMs = idleMs;
    this.now = now;
    this.onIdle = onIdle;
    this.onActive = onActive;
    this.enabled = false;
    this.idle = false;
    this.lastActivity = 0;
  }

  // Returns true only when tracking actually started, so repeated calls are harmless.
  enable() {
    if (this.enabled) return false;
    this.enabled = true;
    this.idle = false;
    this.lastActivity = this.now();
    return true;
  }

  disable() {
    if (!this.enabled) return;
    this.enabled = false;
    if (this.idle) {
      this.idle = false;
      this.onActive();
    }
  }

  activity() {
    if (!this.enabled) return;
    this.lastActivity = this.now();
    if (this.idle) {
      this.idle = false;
      this.onActive();
    }
  }

  check() {
    if (!this.enabled || this.idle) return;
    if (this.now() - this.lastActivity >= this.idleMs) {
      this.idle = true;
      this.onIdle();
    }
  }
}

module.exports = { IdleTracker };
