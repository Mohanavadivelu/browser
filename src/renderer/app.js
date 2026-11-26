'use strict';

// The toolbar (tab strip, address bar, buttons, bookmarks bar). Its parts are separate scripts
// loaded before this one (see index.html); this one draws the toolbar, wires the buttons and
// listens to the main process.

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

  const bookmarked = Boolean(tab && state.bookmarked);
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

function render() {
  document.body.classList.toggle('fs', state.fullscreen || state.htmlFullscreen);
  document.body.classList.toggle('reveal', state.revealed);
  renderTabs();
  renderToolbar();
  document.body.classList.toggle('no-bar', !state.showBookmarksBar);
  renderBookmarks();
  refreshBarIcons();
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

$('newTab').addEventListener('click', () => api.tabs.create());
$('back').addEventListener('click', () => api.nav.back());
$('forward').addEventListener('click', () => api.nav.forward());
$('reload').addEventListener('click', () => (activeTab()?.loading ? api.nav.stop() : api.nav.reload()));
$('home').addEventListener('click', () => api.nav.home());
$('star').addEventListener('click', openStar);
api.onStar(openStar);
$('zoom').addEventListener('click', () => api.zoom.reset());
$('shot').addEventListener('click', () => api.screenshot());
$('record').addEventListener('click', toggleRecording);
$('recPause').addEventListener('click', togglePause);
$('recStop').addEventListener('click', stopRecording);
$('recMark').addEventListener('click', () => api.recording.mark());
$('fullscreen').addEventListener('click', () => api.window.toggleFullscreen());
$('menu').addEventListener('click', () => api.window.showMenu());

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
  // Moving to another tab (or page) saves and closes the star's popover.
  if (starBookmark && state && (next.activeId !== state.activeId || activeTabUrl(next) !== activeTabUrl(state))) closeStar(true);
  const before = activeTab();
  state = next;
  followShield(before, activeTab());
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
