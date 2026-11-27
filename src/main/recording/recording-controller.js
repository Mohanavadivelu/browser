'use strict';

const path = require('node:path');
const { Recorder } = require('./recorder');
const { isLive } = require('../live');

const AUTO_STOP_CHECK_MS = 250;
// How long the toolbar gets to stop its capture and send the last chunks before the recording
// is closed without them.
const CAPTURE_STOP_TIMEOUT_MS = 3000;

// Resolves when the page has finished loading, or after a short limit so capture is never blocked.
function waitUntilLoaded(contents, limitMs = 4000) {
  if (!contents || contents.isDestroyed() || !contents.isLoading()) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      contents.removeListener('did-stop-loading', done);
      resolve();
    };
    const timer = setTimeout(done, limitMs);
    contents.once('did-stop-loading', done);
  });
}

// Everything around the Recorder: consent, which tab is captured (and following tab switches),
// the length limit from Settings, stopping through the toolbar so the last chunks are kept, and
// the recording actions for shortcuts and the REC controls.
// `ctx`: settings, host, ui, win, getTabs(), getFolder(), recordingsIndex, notify, pushState,
// broadcastToLibrary, requestConsent(), minuteMs (a shorter "minute" in tests).
function createRecordingController(ctx) {
  const { settings, host, ui, getTabs, getFolder, recordingsIndex, notify, pushState, broadcastToLibrary, requestConsent } = ctx;
  const minuteMs = ctx.minuteMs ?? 60_000;
  let recordingTabId = null;
  let autoStopped = 0; // the limit in minutes, while a recording it stopped is being saved

  const recorder = new Recorder({
    getFolder,
    requestConsent,
    onChange: () => {
      host.setRecording(recorder.active);
      pushState();
    },
    notify,
    onFailure: () => { stopCapture(); },
    onSegment: (filePath, durationMs, final, { failed = false, markers = [] } = {}) => {
      if (recorder.removeIfEmpty(filePath)) {
        if (final && !failed) notify('The recording was empty and was not saved. Keep the page visible while recording.', 'error');
        return;
      }
      recordingsIndex.set(path.basename(filePath), durationMs);
      recordingsIndex.setMarkers(path.basename(filePath), markers);
      // After a write error the error notice stays up instead of a "saved" message.
      if (final && !failed) {
        notify(autoStopped ? `Recording stopped after ${autoStopped} min, as set in Settings, and saved: ${filePath}` : `Recording saved: ${filePath}`);
      }
      if (final) autoStopped = 0;
      broadcastToLibrary('recordings:changed');
    },
  });

  const limitMs = () => settings.data.recordingStopAfter * minuteMs;

  // Asks the toolbar to stop its capture, so the chunks it still holds are written, and makes
  // sure the recording ends even if the toolbar does not answer in time.
  const stopCapture = async () => {
    if (!recorder.active) return;
    if (isLive(ui.webContents)) ui.webContents.send('recording:command', 'stop');
    if (!(await recorder.whenIdle(CAPTURE_STOP_TIMEOUT_MS))) await recorder.finish();
  };

  // Stops a recording once it reaches the length chosen in Settings (paused time does not count).
  setInterval(() => {
    const limit = limitMs();
    if (!limit || !recorder.active || autoStopped || recorder.clock.elapsed() < limit) return;
    autoStopped = settings.data.recordingStopAfter;
    stopCapture().catch((error) => console.error(`Could not stop the recording: ${error.message}`));
  }, AUTO_STOP_CHECK_MS).unref?.();

  // The display-media handler of the browser's own session: only the toolbar, only right after
  // the consent, and only the active tab's page and its sound (never other windows, apps or the
  // microphone).
  const handleDisplayMedia = async (requester, callback) => {
    const tabs = getTabs();
    const allowed = requester?.id === ui.webContents.id && recorder.consumeAuthorization();
    // A tab that is still loading swaps its frame when the page commits, so wait for it to settle.
    if (allowed) await waitUntilLoaded(tabs.active?.view.webContents);
    const page = allowed ? tabs.active?.view.webContents.mainFrame : null;
    if (page) recordingTabId = tabs.activeId;
    callback(page ? { video: page, audio: page } : null);
  };

  // The microphone only for the toolbar, only while a recording runs with narration turned on.
  const allowMicrophone = (contents) => contents?.id === ui.webContents.id && settings.data.recordingMicrophone && recorder.active;

  // A recording that follows the user moves to the tab they switch to.
  const onTabActivated = (id) => {
    if (recorder.active && settings.data.recordingFollowTab && id !== recordingTabId) {
      ui.webContents.send('recording:command', 'retarget');
    }
  };

  const actions = {
    toggleRecording: () => ui.webContents.send('recording:command', recorder.active ? 'stop' : 'start'),
    // A marker at the current moment of the recording (Ctrl+Shift+M, or Mark on the REC controls).
    addMarker: () => {
      const marker = recorder.addMarker();
      if (!marker) return null;
      const seconds = Math.floor(marker.timeMs / 1000);
      const at = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
      notify(`Marker ${marker.number} at ${at}${marker.part > 1 ? ` in part ${marker.part}` : ''}`);
      return marker;
    },
    togglePause: () => {
      if (recorder.active) ui.webContents.send('recording:command', 'toggle-pause');
    },
  };

  return {
    recorder,
    stopCapture,
    handleDisplayMedia,
    allowMicrophone,
    onTabActivated,
    actions,
    // For the toolbar and the REC indicator.
    state: () => ({ ...recorder.info, limitMs: limitMs() }),
  };
}

module.exports = { createRecordingController, waitUntilLoaded, CAPTURE_STOP_TIMEOUT_MS };
