'use strict';

const api = window.browserApi;
const $ = (id) => document.getElementById(id);

let state = null;
let addressFocused = false;
let pointerInside = false;
let noticeTimer;
let hideTimer;

function activeTab() {
  return state?.tabs.find((tab) => tab.id === state.activeId) ?? null;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderTabs() {
  const strip = $('tabs');
  strip.replaceChildren();
  for (const tab of state.tabs) {
    const node = element('div', `tab${tab.id === state.activeId ? ' active' : ''}${tab.isPrivate ? ' private' : ''}`);
    if (tab.favicon) {
      const icon = element('img', 'fav');
      icon.src = tab.favicon;
      icon.alt = '';
      node.append(icon);
    } else {
      node.append(element('span', 'fav'));
    }
    node.append(element('span', 'title', tab.title));
    if (tab.isPrivate) node.append(element('span', 'private-tag', 'Private'));
    const close = element('button', 'close', '✕');
    close.title = 'Close tab';
    close.addEventListener('click', (event) => { event.stopPropagation(); api.tabs.close(tab.id); });
    node.append(close);
    node.addEventListener('click', () => api.tabs.activate(tab.id));
    node.addEventListener('auxclick', (event) => { if (event.button === 1) api.tabs.close(tab.id); });
    strip.append(node);
  }
}

function renderToolbar() {
  const tab = activeTab();
  $('back').disabled = !tab?.canGoBack;
  $('forward').disabled = !tab?.canGoForward;
  $('reload').textContent = tab?.loading ? '✕' : '⟳';
  $('reload').title = tab?.loading ? 'Stop' : 'Reload (Ctrl+R)';
  $('loading').classList.toggle('show', Boolean(tab?.loading));

  if (!addressFocused) $('address').value = tab?.url ?? '';
  const security = $('security');
  const secure = tab?.url.startsWith('https:');
  const insecure = tab?.url.startsWith('http:');
  security.textContent = secure ? '🔒' : insecure ? 'Not secure' : '';
  security.classList.toggle('warn', Boolean(insecure));

  const bookmarked = Boolean(tab && state.bookmarks.some((bookmark) => bookmark.url === tab.url));
  $('star').textContent = bookmarked ? '★' : '☆';
  $('star').classList.toggle('on', bookmarked);

  const percent = Math.round((tab?.zoom ?? 1) * 100);
  $('zoom').classList.toggle('show', percent !== 100);
  $('zoom').textContent = `${percent}%`;
}

function renderBookmarks() {
  const bar = $('bookmarks');
  bar.replaceChildren();
  if (state.bookmarks.length === 0) {
    bar.append(element('span', 'hint', 'Press ☆ in the address bar to bookmark a page.'));
    return;
  }
  for (const bookmark of state.bookmarks) {
    const chip = element('button', 'chip', `★ ${bookmark.title}`);
    chip.title = bookmark.url;
    chip.addEventListener('click', () => api.nav.go(bookmark.url));
    bar.append(chip);
  }
}

function elapsedMs(recording) {
  return recording.baseMs + (recording.runningSince === null ? 0 : Date.now() - recording.runningSince);
}

function formatElapsed(recording) {
  const seconds = Math.max(0, Math.floor(elapsedMs(recording) / 1000));
  const pad = (value) => String(value).padStart(2, '0');
  return `${recording.paused ? 'PAUSED' : 'REC'} ${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`;
}

function renderRecording() {
  const { active, paused } = state.recording;
  $('record').classList.toggle('recording', active);
  $('record').title = active ? 'Stop recording (Ctrl+Shift+R)' : 'Record this page (Ctrl+Shift+R)';
  $('recBadge').classList.toggle('show', active);
  $('recBadge').classList.toggle('paused', paused);
  $('recPause').textContent = paused ? 'Resume' : 'Pause';
  if (active) $('recTime').textContent = formatElapsed(state.recording);
}

function render() {
  document.body.classList.toggle('fs', state.fullscreen || state.htmlFullscreen);
  document.body.classList.toggle('reveal', state.revealed);
  renderTabs();
  renderToolbar();
  renderBookmarks();
  renderRecording();
}

function showNotice({ text, kind }) {
  const notice = $('notice');
  notice.textContent = text;
  notice.className = `notice show ${kind}`;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => notice.classList.remove('show'), 4000);
  if (state?.fullscreen) {
    api.window.reveal(true);
    scheduleHide(4200);
  }
}

function scheduleHide(delay = 250) {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (state?.fullscreen && !pointerInside && !addressFocused) api.window.reveal(false);
  }, delay);
}

// The capture currently feeding the recording. When the recording follows the user to another
// tab, the old capture is closed (that part is saved) and a new one starts in the next file.
let capture = null;
let retargeting = false;
let retargetAgain = false;
let stopAfterRetarget = false;

function qualitySettings(key) {
  return state.qualities.find((quality) => quality.key === key) ?? state.qualities[1];
}

async function beginCapture(qualityKey) {
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
  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: quality.videoBitsPerSecond,
    audioBitsPerSecond: quality.audioBitsPerSecond,
  });
  const current = { recorder, final: true, pending: Promise.resolve(), stopped: null };

  recorder.ondataavailable = (event) => {
    if (!event.data.size) return;
    current.pending = current.pending.then(async () => api.recording.chunk(new Uint8Array(await event.data.arrayBuffer())));
  };
  current.stopped = new Promise((resolve) => {
    recorder.onstop = async () => {
      stream.getTracks().forEach((track) => track.stop());
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
  if (state.recording.paused) recorder.pause();
  return current;
}

// A capture can fail if the tab's frame was replaced a moment earlier, so try a few times.
async function beginCaptureWithRetry(qualityKey) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await beginCapture(qualityKey);
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
    await beginCaptureWithRetry(grant.quality);
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
    await beginCaptureWithRetry(result.quality);
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
    stopRecording();
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
  if (!capture || retargeting) return;
  const pause = capture.recorder.state === 'recording';
  if (pause) capture.recorder.pause();
  else if (capture.recorder.state === 'paused') capture.recorder.resume();
  api.recording.setPaused(pause);
}

function toggleRecording() {
  if (state?.recording.active) stopRecording();
  else startRecording();
}

$('newTab').addEventListener('click', () => api.tabs.create());
$('back').addEventListener('click', () => api.nav.back());
$('forward').addEventListener('click', () => api.nav.forward());
$('reload').addEventListener('click', () => (activeTab()?.loading ? api.nav.stop() : api.nav.reload()));
$('home').addEventListener('click', () => api.nav.home());
$('star').addEventListener('click', () => api.bookmarks.toggle());
$('zoom').addEventListener('click', () => api.zoom.reset());
$('shot').addEventListener('click', () => api.screenshot());
$('record').addEventListener('click', toggleRecording);
$('recPause').addEventListener('click', togglePause);
$('recStop').addEventListener('click', stopRecording);
$('fullscreen').addEventListener('click', () => api.window.toggleFullscreen());
$('menu').addEventListener('click', () => api.window.showMenu());

$('addressForm').addEventListener('submit', (event) => {
  event.preventDefault();
  api.nav.go($('address').value);
  $('address').blur();
});
$('address').addEventListener('focus', () => { addressFocused = true; $('address').select(); });
$('address').addEventListener('blur', () => { addressFocused = false; renderToolbar(); scheduleHide(); });

document.addEventListener('mouseover', () => {
  pointerInside = true;
  clearTimeout(hideTimer);
  if (state?.fullscreen) api.window.reveal(true);
});
document.documentElement.addEventListener('mouseleave', () => {
  pointerInside = false;
  scheduleHide();
});

api.onState((next) => {
  state = next;
  // The main process ended the recording on its own (a write error, or the toolbar did not stop
  // in time): stop a capture that is still running, so it does not keep going unseen.
  if (!state.recording.active && capture && !retargeting) stopRecording();
  render();
});
api.onNotice(showNotice);
api.onFocusAddress(() => $('address').focus());
api.onRecordingCommand((command) => {
  if (command === 'stop') stopRecording();
  else if (command === 'start') startRecording();
  else if (command === 'toggle-pause') togglePause();
  else if (command === 'retarget') retarget();
});
setInterval(() => { if (state?.recording.active) renderRecording(); }, 500);

api.getState().then((initial) => { state = initial; render(); });
