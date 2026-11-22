'use strict';

const api = window.browserApi;
const $ = (id) => document.getElementById(id);

let state = null;
let addressFocused = false;
let pointerInside = false;
let noticeTimer;
let hideTimer;
let capture = null;

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

function formatElapsed(startedAt) {
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const pad = (value) => String(value).padStart(2, '0');
  return `REC ${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`;
}

function renderRecording() {
  const active = state.recording.active;
  $('record').classList.toggle('recording', active);
  $('record').title = active ? 'Stop recording' : 'Record this window';
  $('recBadge').classList.toggle('show', active);
  if (active) $('recTime').textContent = formatElapsed(state.recording.startedAt);
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

async function startRecording() {
  const grant = await api.recording.requestStart();
  if (!grant.ok) return;
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false });
    const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
      .find((type) => MediaRecorder.isTypeSupported(type));
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 5_000_000 });
    let pending = Promise.resolve();
    recorder.ondataavailable = (event) => {
      if (!event.data.size) return;
      pending = pending.then(async () => api.recording.chunk(new Uint8Array(await event.data.arrayBuffer())));
    };
    recorder.onstop = async () => {
      stream.getTracks().forEach((track) => track.stop());
      await pending;
      capture = null;
      await api.recording.finish();
    };
    stream.getVideoTracks()[0].addEventListener('ended', stopRecording);
    capture = { recorder };
    recorder.start(1000);
  } catch (error) {
    console.error(`Could not start capture: ${error.name}: ${error.message}`);
    await api.recording.abort();
  }
}

function stopRecording() {
  if (capture && capture.recorder.state !== 'inactive') capture.recorder.stop();
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
$('record').addEventListener('click', toggleRecording);
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

api.onState((next) => { state = next; render(); });
api.onNotice(showNotice);
api.onFocusAddress(() => $('address').focus());
api.onRecordingCommand((command) => (command === 'stop' ? stopRecording() : startRecording()));
setInterval(() => { if (state?.recording.active) renderRecording(); }, 500);

api.getState().then((initial) => { state = initial; render(); });
