'use strict';

// Memory saver: tabs left in the background for a while are put to sleep (see TabManager.sleep),
// which closes their page's process; they wake where they were when shown again. Tabs that are
// playing sound, pinned, being recorded, still loading, or with something typed in them are left
// awake. `minutes()` is the setting: 0 turns it off.
const MINUTES_CHOICES = Object.freeze([0, 15, 30, 60, 120, 240]);
const DEFAULT_MINUTES = 30;
const CHECK_EVERY_MS = 60 * 1000;

class MemorySaver {
  constructor({ tabs, minutes, isBusy = () => false, now = Date.now, checkEveryMs = CHECK_EVERY_MS }) {
    Object.assign(this, { tabs, minutes, isBusy, now, checkEveryMs });
    this.timer = null;
    this.checking = false;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.check().catch(() => {}), this.checkEveryMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  // Puts to sleep every tab that has been in the background longer than the setting allows.
  // Returns how many went to sleep.
  async check() {
    const minutes = this.minutes();
    if (!minutes || this.checking) return 0;
    this.checking = true;
    try {
      const cutoff = this.now() - minutes * 60 * 1000;
      let slept = 0;
      for (const tab of [...this.tabs.tabs.values()]) {
        if (!tab.inactiveSince || tab.inactiveSince > cutoff) continue;
        if (await this.tabs.canSleep(tab.id, { isBusy: this.isBusy }) && this.tabs.sleep(tab.id)) slept += 1;
      }
      return slept;
    } finally {
      this.checking = false;
    }
  }
}

module.exports = { MemorySaver, MINUTES_CHOICES, DEFAULT_MINUTES };
