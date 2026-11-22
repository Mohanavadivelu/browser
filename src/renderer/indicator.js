'use strict';

const api = window.browserApi;
let startedAt = null;

function render() {
  if (startedAt === null) return;
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const pad = (value) => String(value).padStart(2, '0');
  document.getElementById('time').textContent = `REC ${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`;
}

api.onState((state) => {
  startedAt = state.recording.active ? state.recording.startedAt : null;
  render();
});
document.getElementById('stop').addEventListener('click', () => api.recording.requestStop());
setInterval(render, 500);
api.getState().then((state) => { startedAt = state.recording.active ? state.recording.startedAt : null; render(); });
