'use strict';

const QUALITY = Object.freeze({
  low: { label: 'Low', width: 1280, height: 720, frameRate: 15, videoBitsPerSecond: 1_500_000 },
  medium: { label: 'Medium', width: 1920, height: 1080, frameRate: 30, videoBitsPerSecond: 5_000_000 },
  high: { label: 'High', width: 2560, height: 1440, frameRate: 60, videoBitsPerSecond: 10_000_000 },
});
const DEFAULT_QUALITY = 'medium';
const AUDIO_BITS_PER_SECOND = 128_000;

function estimateMbPerMinute(quality) {
  return Math.round(((quality.videoBitsPerSecond + AUDIO_BITS_PER_SECOND) * 60) / 8 / 1_000_000);
}

// What the interface needs to start a capture and to describe each choice to the user.
function publicQualities() {
  return Object.entries(QUALITY).map(([key, quality]) => ({
    key,
    ...quality,
    audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
    description: `${quality.label}: up to ${quality.height}p, ${quality.frameRate} fps, about ${estimateMbPerMinute(quality)} MB per minute`,
  }));
}

module.exports = { QUALITY, DEFAULT_QUALITY, AUDIO_BITS_PER_SECOND, estimateMbPerMinute, publicQualities };
