'use strict';

// Recording from the toolbar: the REC button and clock, and the tab capture that feeds the
// main process's recorder (with narration mixed in), following the user to other tabs.

function elapsedMs(recording) {
  return recording.baseMs + (recording.runningSince === null ? 0 : Date.now() - recording.runningSince);
}

function formatElapsed(recording) {
  const pad = (value) => String(value).padStart(2, '0');
  const clock = (ms) => {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    return `${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`;
  };
  // "REC 01:12 / 30:00" while a stop-after limit is set.
  const limit = recording.limitMs ? ` / ${clock(recording.limitMs)}` : '';
  return `${recording.paused ? 'PAUSED' : 'REC'} ${clock(elapsedMs(recording))}${limit}`;
}

function renderRecording() {
  const { active, paused } = state.recording;
  $('record').classList.toggle('recording', active);
  $('record').title = active ? 'Stop recording (Ctrl+Shift+E)' : 'Record this page (Ctrl+Shift+E)';
  $('recBadge').classList.toggle('show', active);
  $('recBadge').classList.toggle('paused', paused);
  $('recPause').textContent = paused ? 'Resume' : 'Pause';
  if (active) $('recTime').textContent = formatElapsed(state.recording);
}

// The capture currently feeding the recording. When the recording follows the user to another
// tab, the old capture is closed (that part is saved) and a new one starts in the next file.
let capture = null;
let retargeting = false;
let retargetAgain = false;
let stopAfterRetarget = false;
// Pause or Resume pressed while the capture was moving to another tab, to apply afterwards.
let pauseAfterRetarget = false;

const KEYFRAME_INTERVAL_MS = 2000;

function qualitySettings(key) {
  return state.qualities.find((quality) => quality.key === key) ?? state.qualities[1];
}

// Mixes the microphone into the tab's sound. Returns the stream to record and a function that
// releases what was opened for it. If the microphone cannot be used, the tab's stream as it is.
async function withMicrophone(tabStream) {
  let microphone;
  try {
    microphone = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
  } catch (error) {
    console.error(`Microphone not available: ${error.name}: ${error.message}`);
    api.recording.microphoneFailed();
    return { stream: tabStream, release: () => {} };
  }
  const context = new AudioContext();
  const mix = context.createMediaStreamDestination();
  // The page and the voice are added together; a limiter keeps the sum from clipping.
  const limiter = context.createDynamicsCompressor();
  limiter.threshold.value = -3;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.25;
  limiter.connect(mix);
  for (const track of [...tabStream.getAudioTracks(), ...microphone.getAudioTracks()]) {
    context.createMediaStreamSource(new MediaStream([track])).connect(limiter);
  }
  return {
    stream: new MediaStream([...tabStream.getVideoTracks(), ...mix.stream.getAudioTracks()]),
    release: () => {
      microphone.getTracks().forEach((track) => track.stop());
      context.close().catch(() => {});
    },
  };
}

async function beginCapture(qualityKey, useMicrophone = false) {
  const quality = qualitySettings(qualityKey);
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: quality.frameRate },
    audio: true,
  });
  // Page capture ignores size limits given up front, so the quality limits are applied to the
  // track, and recording waits until the track has really switched to the smaller size.
  const track = stream.getVideoTracks()[0];
  try {
    await track.applyConstraints({
      width: { max: quality.width },
      height: { max: quality.height },
      frameRate: { max: quality.frameRate },
    });
    for (let i = 0; i < 30; i++) {
      const { width, height } = track.getSettings();
      if (width <= quality.width && height <= quality.height) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  } catch (error) {
    console.error(`Could not apply the quality limits: ${error.name}: ${error.message}`);
  }
  const mimeType = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    .find((type) => MediaRecorder.isTypeSupported(type));
  const recorded = useMicrophone ? await withMicrophone(stream) : { stream, release: () => {} };
  const recorder = new MediaRecorder(recorded.stream, {
    mimeType,
    videoBitsPerSecond: quality.videoBitsPerSecond,
    audioBitsPerSecond: quality.audioBitsPerSecond,
    // A keyframe every 2 s gives the seek index a point at least every 2 s.
    videoKeyFrameIntervalDuration: KEYFRAME_INTERVAL_MS,
  });
  const current = { recorder, final: true, pending: Promise.resolve(), stopped: null };

  recorder.ondataavailable = (event) => {
    if (!event.data.size) return;
    current.pending = current.pending.then(async () => api.recording.chunk(new Uint8Array(await event.data.arrayBuffer())));
  };
  current.stopped = new Promise((resolve) => {
    recorder.onstop = async () => {
      stream.getTracks().forEach((track) => track.stop());
      recorded.release();
      await current.pending;
      resolve();
      if (!current.final) return;
      if (capture === current) capture = null;
      await api.recording.finish();
    };
  });
  // The recorded tab was closed: wait briefly in case the recording is moving to another tab.
  stream.getVideoTracks()[0].addEventListener('ended', () => {
    setTimeout(() => { if (capture === current && !retargeting) stopRecording(); }, 400);
  });

  capture = current;
  recorder.start(1000);
  api.recording.captureStarted();
  if (state.recording.paused) recorder.pause();
  return current;
}

// A capture can fail if the tab's frame was replaced a moment earlier, so try a few times.
async function beginCaptureWithRetry(qualityKey, useMicrophone) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await beginCapture(qualityKey, useMicrophone);
    } catch (error) {
      lastError = error;
      console.error(`Capture attempt ${attempt + 1} failed: ${error.name}: ${error.message}`);
      if (attempt === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 700));
      if (!(await api.recording.reauthorize()).ok) break;
    }
  }
  throw lastError;
}

async function startRecording() {
  const grant = await api.recording.requestStart();
  if (!grant.ok) return;
  try {
    await beginCaptureWithRetry(grant.quality, grant.microphone);
  } catch (error) {
    console.error(`Could not start capture: ${error.name}: ${error.message}`);
    capture = null;
    await api.recording.abort();
  }
}

async function switchCapture() {
  const old = capture;
  if (!old) return false;
  old.final = false;
  if (old.recorder.state !== 'inactive') old.recorder.stop();
  await old.stopped;
  const result = await api.recording.rollover();
  if (!result.ok) {
    capture = null;
    return false;
  }
  try {
    await beginCaptureWithRetry(result.quality, result.microphone);
    return true;
  } catch (error) {
    console.error(`Could not follow the new tab: ${error.name}: ${error.message}`);
    capture = null;
    await api.recording.finish();
    return false;
  }
}

async function retarget() {
  if (!capture) return;
  if (retargeting) {
    retargetAgain = true;
    return;
  }
  retargeting = true;
  try {
    do {
      retargetAgain = false;
      if (!(await switchCapture())) break;
    } while (retargetAgain);
  } finally {
    retargeting = false;
  }
  if (stopAfterRetarget) {
    stopAfterRetarget = false;
    pauseAfterRetarget = false;
    stopRecording();
  } else if (pauseAfterRetarget) {
    pauseAfterRetarget = false;
    togglePause();
  }
}

function stopRecording() {
  if (retargeting) {
    stopAfterRetarget = true;
    return;
  }
  if (capture && capture.recorder.state !== 'inactive') capture.recorder.stop();
}

function togglePause() {
  if (retargeting) {
    // Pressing it twice during the switch cancels out.
    pauseAfterRetarget = !pauseAfterRetarget;
    return;
  }
  if (!capture) return;
  const { state: recorderState } = capture.recorder;
  if (recorderState !== 'recording' && recorderState !== 'paused') return;
  const pause = recorderState === 'recording';
  if (pause) capture.recorder.pause();
  else capture.recorder.resume();
  api.recording.setPaused(pause);
}

function toggleRecording() {
  if (state?.recording.active) stopRecording();
  else startRecording();
}
