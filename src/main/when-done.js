'use strict';

const { EventEmitter } = require('node:events');

// "When all downloads finish": nothing, sleep, or shut the computer down. It is chosen on the
// Downloads page for this session only, and acts once downloads that were running have all
// finished (paused and failed ones don't hold it up; ones waiting in the queue do). It never acts
// at once: a countdown is shown first, and can be cancelled. Then the choice goes back to nothing.
const ACTIONS = Object.freeze(['none', 'sleep', 'shutdown']);
const COUNTDOWN_MS = 60 * 1000;

class WhenDone extends EventEmitter {
  // `run(action)` sleeps or shuts down; `notify(text, kind)` tells the user.
  constructor({ downloads, run, notify = () => {}, countdownMs = COUNTDOWN_MS, now = Date.now }) {
    super();
    Object.assign(this, { downloads, run, notify, countdownMs, now });
    this.action = 'none';
    this.sawWork = false;
    this.endsAt = 0;
    this.timer = null;
    downloads.on('change', () => this.check());
  }

  state() {
    return { action: this.action, endsAt: this.endsAt, actions: ACTIONS };
  }

  set(action) {
    if (!ACTIONS.includes(action)) return this.state();
    this.cancelCountdown();
    this.action = action;
    this.sawWork = !this.downloads.idle;
    this.emit('change', this.state());
    return this.state();
  }

  cancel() {
    if (!this.timer) return this.state();
    this.cancelCountdown();
    this.action = 'none';
    this.notify('Cancelled: the computer stays on.');
    this.emit('change', this.state());
    return this.state();
  }

  cancelCountdown() {
    clearTimeout(this.timer);
    this.timer = null;
    this.endsAt = 0;
  }

  check() {
    if (this.action === 'none') return;
    if (!this.downloads.idle) {
      this.sawWork = true;
      // Something started again: no need to stop the computer yet.
      if (this.timer) {
        this.cancelCountdown();
        this.emit('change', this.state());
      }
      return;
    }
    if (!this.sawWork || this.timer) return;
    this.endsAt = this.now() + this.countdownMs;
    const action = this.action;
    const seconds = Math.round(this.countdownMs / 1000);
    this.notify(`Downloads finished: the computer will ${action === 'sleep' ? 'sleep' : 'shut down'} in ${seconds} seconds. Cancel on the Downloads page.`, 'warning');
    this.timer = setTimeout(() => {
      this.timer = null;
      this.endsAt = 0;
      this.action = 'none';
      this.sawWork = false;
      this.emit('change', this.state());
      this.run(action);
    }, this.countdownMs);
    this.timer.unref?.();
    this.emit('change', this.state());
  }
}

module.exports = { WhenDone, ACTIONS: ACTIONS, COUNTDOWN_MS };
