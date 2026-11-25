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

// The tab being dragged to a new place; the strip is not rebuilt while a drag is under way.
const TAB_DRAG_TYPE = 'application/x-simple-browser-tab';
let draggingTab = null;

function renderTabs() {
  if (draggingTab !== null) return;
  const strip = $('tabs');
  strip.replaceChildren();
  for (const tab of state.tabs) {
    const node = element('div', `tab${tab.id === state.activeId ? ' active' : ''}${tab.isPrivate ? ' private' : ''}`);
    node.dataset.id = String(tab.id);
    node.draggable = true;
    if (tab.favicon) {
      const icon = element('img', 'fav');
      icon.src = tab.favicon;
      icon.alt = '';
      icon.draggable = false;
      node.append(icon);
    } else {
      node.append(element('span', 'fav'));
    }
    node.append(element('span', 'title', tab.title));
    if (tab.isPrivate) node.append(element('span', 'private-tag', 'Private'));
    if (tab.audible || tab.muted) {
      const sound = element('button', 'sound', tab.muted ? '🔇' : '🔊');
      sound.title = tab.muted ? 'Unmute this tab' : 'Mute this tab';
      sound.addEventListener('click', (event) => { event.stopPropagation(); api.tabs.toggleMute(tab.id); });
      node.append(sound);
    }
    const close = element('button', 'close', '✕');
    close.title = 'Close tab';
    close.addEventListener('click', (event) => { event.stopPropagation(); api.tabs.close(tab.id); });
    node.append(close);
    node.addEventListener('click', () => api.tabs.activate(tab.id));
    node.addEventListener('auxclick', (event) => { if (event.button === 1) api.tabs.close(tab.id); });
    node.addEventListener('dragstart', (event) => {
      draggingTab = tab.id;
      event.dataTransfer.setData(TAB_DRAG_TYPE, String(tab.id));
      event.dataTransfer.effectAllowed = 'move';
      node.classList.add('dragging');
    });
    node.addEventListener('dragend', endTabDrag);
    strip.append(node);
  }
}

// Where a dropped tab goes: before the first other tab whose middle is right of the pointer.
function dropIndex(clientX) {
  const others = [...$('tabs').children].filter((node) => Number(node.dataset.id) !== draggingTab);
  const index = others.findIndex((node) => {
    const box = node.getBoundingClientRect();
    return clientX < box.left + box.width / 2;
  });
  return { others, index: index === -1 ? others.length : index };
}

function markDropPlace(clientX) {
  const { others, index } = dropIndex(clientX);
  others.forEach((node, i) => {
    node.classList.toggle('drop-before', i === index);
    node.classList.toggle('drop-after', index === others.length && i === others.length - 1);
  });
}

function endTabDrag() {
  draggingTab = null;
  if (state) renderTabs();
}

$('tabs').addEventListener('dragover', (event) => {
  if (draggingTab === null || !event.dataTransfer.types.includes(TAB_DRAG_TYPE)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  markDropPlace(event.clientX);
});
$('tabs').addEventListener('drop', (event) => {
  if (draggingTab === null) return;
  event.preventDefault();
  const id = Number(event.dataTransfer.getData(TAB_DRAG_TYPE));
  const { index } = dropIndex(event.clientX);
  if (id === draggingTab) api.tabs.move(id, index);
  endTabDrag();
});

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

  renderShield(tab);

  const update = state.update ?? {};
  const updateWaiting = update.status === 'ready' || update.status === 'available';
  $('menu').classList.toggle('update', updateWaiting);
  $('menu').title = updateWaiting ? `Menu: Simple Browser ${update.version} is ${update.status === 'ready' ? 'ready to install' : 'available'}` : 'Menu';

  const percent = Math.round((tab?.zoom ?? 1) * 100);
  $('zoom').classList.toggle('show', percent !== 100);
  $('zoom').textContent = `${percent}%`;
}

// The shield in the address bar: how many ads and trackers were blocked on this page, and a
// switch to allow them on this site.
function renderShield(tab) {
  const shield = $('shield');
  const blocker = state.blocker;
  let site = '';
  try {
    if (tab && /^https?:/.test(tab.url)) site = new URL(tab.url).hostname;
  } catch {
    site = '';
  }
  shield.hidden = !site || !blocker?.enabled;
  if (shield.hidden) return;
  const allowed = blocker.allowedSites.includes(site);
  shield.classList.toggle('off', allowed);
  shield.textContent = allowed ? '🛡 off' : `🛡 ${tab.blocked}`;
  if (allowed) shield.title = `Ads and trackers are allowed on ${site}. Click to block them again.`;
  else if (!blocker.ready) shield.title = 'The ad and tracker lists are still downloading.';
  else shield.title = `${tab.blocked} ads and trackers blocked on this page. Click to allow them on ${site}.`;
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

$('newTab').addEventListener('click', () => api.tabs.create());
$('back').addEventListener('click', () => api.nav.back());
$('forward').addEventListener('click', () => api.nav.forward());
$('reload').addEventListener('click', () => (activeTab()?.loading ? api.nav.stop() : api.nav.reload()));
$('home').addEventListener('click', () => api.nav.home());
$('star').addEventListener('click', () => api.bookmarks.toggle());
$('zoom').addEventListener('click', () => api.zoom.reset());
$('shield').addEventListener('click', () => api.blocker.toggleSite());
$('shot').addEventListener('click', () => api.screenshot());
$('record').addEventListener('click', toggleRecording);
$('recPause').addEventListener('click', togglePause);
$('recStop').addEventListener('click', stopRecording);
$('recMark').addEventListener('click', () => api.recording.mark());
$('fullscreen').addEventListener('click', () => api.window.toggleFullscreen());
$('menu').addEventListener('click', () => api.window.showMenu());

// ---------- Address-bar suggestions ----------
// The first suggestion is what the typed text does on its own; the arrow keys move through
// the list, Enter or a click opens the selected one, Esc closes it.
const KIND_ICONS = { search: '🔍', address: '🌐', page: '⚙', bookmark: '★', history: '🕘' };
let suggestions = [];
let selected = 0;
let suggestTimer;
let suggestSeq = 0;

function closeSuggestions() {
  clearTimeout(suggestTimer);
  suggestSeq += 1; // drop answers still on their way
  suggestions = [];
  $('suggestions').hidden = true;
  $('suggestions').replaceChildren();
  $('address').setAttribute('aria-expanded', 'false');
  api.window.setSuggestionsHeight(0);
}

function renderSuggestions() {
  const list = $('suggestions');
  if (suggestions.length === 0) {
    closeSuggestions();
    return;
  }
  list.replaceChildren(...suggestions.map((item, index) => {
    const row = element('div', `suggestion${index === selected ? ' selected' : ''}`);
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(index === selected));
    row.append(element('span', 'kind', KIND_ICONS[item.kind] ?? '•'), element('span', 'title', item.title));
    if (item.kind === 'bookmark' || item.kind === 'history') row.append(element('span', 'url', item.url));
    // mousedown keeps the focus in the address bar, so the click below still lands.
    row.addEventListener('mousedown', (event) => event.preventDefault());
    row.addEventListener('click', () => openSuggestion(index));
    return row;
  }));
  list.hidden = false;
  $('address').setAttribute('aria-expanded', 'true');
  const needed = Math.ceil(list.getBoundingClientRect().bottom + 8 - document.querySelector('.chrome').offsetHeight);
  api.window.setSuggestionsHeight(Math.max(0, Math.min(needed, 1000)));
}

function querySuggestions() {
  clearTimeout(suggestTimer);
  const text = $('address').value;
  if (!text.trim()) {
    closeSuggestions();
    return;
  }
  const seq = ++suggestSeq;
  suggestTimer = setTimeout(async () => {
    const results = await api.suggest(text.slice(0, 2048));
    if (seq !== suggestSeq || !addressFocused) return;
    suggestions = results;
    selected = 0;
    renderSuggestions();
  }, 60);
}

function openSuggestion(index) {
  const item = suggestions[index];
  // The first entry is the typed text itself; the main process decides what it means.
  api.nav.go(index === 0 && item?.input ? item.input : item?.url ?? $('address').value);
  closeSuggestions();
  $('address').blur();
}

$('address').addEventListener('input', querySuggestions);
$('address').addEventListener('keydown', (event) => {
  if (suggestions.length === 0) return;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const step = event.key === 'ArrowDown' ? 1 : -1;
    selected = (selected + step + suggestions.length) % suggestions.length;
    renderSuggestions();
  } else if (event.key === 'Escape') {
    event.preventDefault();
    closeSuggestions();
  }
});

$('addressForm').addEventListener('submit', (event) => {
  event.preventDefault();
  if (suggestions.length) {
    openSuggestion(selected);
    return;
  }
  api.nav.go($('address').value);
  $('address').blur();
});
$('address').addEventListener('focus', () => { addressFocused = true; $('address').select(); });
$('address').addEventListener('blur', () => {
  addressFocused = false;
  closeSuggestions();
  renderToolbar();
  scheduleHide();
});

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
