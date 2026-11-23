'use strict';

const ZOOM_STEPS = Object.freeze([0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5]);
const EPSILON = 1e-6;

// direction: 1 = zoom in, -1 = zoom out
function stepZoom(current, direction) {
  if (direction > 0) return ZOOM_STEPS.find((step) => step > current + EPSILON) ?? ZOOM_STEPS.at(-1);
  return [...ZOOM_STEPS].reverse().find((step) => step < current - EPSILON) ?? ZOOM_STEPS[0];
}

// Zoom is remembered per site (host name); pages that are not http(s) have no site.
function hostKey(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.hostname.toLowerCase() : '';
  } catch {
    return '';
  }
}

// Regular tabs persist zoom in settings; private tabs keep it in memory only.
class ZoomController {
  constructor({ settings }) {
    this.settings = settings;
  }

  factorFor(tab, url) {
    const host = hostKey(url);
    if (!host) return 1;
    return (tab.isPrivate ? tab.zoomByHost?.get(host) : this.settings.data.zoom[host]) ?? 1;
  }

  apply(tab) {
    const contents = tab.view.webContents;
    if (contents.isDestroyed()) return;
    const factor = this.factorFor(tab, contents.getURL());
    if (Math.abs(contents.getZoomFactor() - factor) > EPSILON) contents.setZoomFactor(factor);
  }

  // direction: 1 in, -1 out, 0 reset. Returns the new factor, or null if the page has no site.
  change(tab, direction) {
    const contents = tab.view.webContents;
    const host = hostKey(contents.getURL());
    if (!host) return null;
    const next = direction === 0 ? 1 : stepZoom(contents.getZoomFactor(), direction);
    if (tab.isPrivate) {
      tab.zoomByHost ??= new Map();
      if (next === 1) tab.zoomByHost.delete(host);
      else tab.zoomByHost.set(host, next);
    } else {
      const zoom = { ...this.settings.data.zoom };
      if (next === 1) delete zoom[host];
      else zoom[host] = next;
      this.settings.update({ zoom });
    }
    contents.setZoomFactor(next);
    return next;
  }
}

module.exports = { ZOOM_STEPS, stepZoom, hostKey, ZoomController };
