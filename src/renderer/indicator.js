'use strict';

const api = window.browserApi;
let recording = null;

function elapsedMs() {
  return recording.baseMs + (recording.runningSince === null ? 0 : Date.now() - recording.runningSince);
}

function render() {
  if (!recording?.active) return;
  const pad = (value) => String(value).padStart(2, '0');
  const clock = (ms) => {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    return `${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`;
  };
  const limit = recording.limitMs ? ` / ${clock(recording.limitMs)}` : '';
  document.getElementById('time').textContent = `${recording.paused ? 'PAUSED' : 'REC'} ${clock(elapsedMs())}${limit}`;
  document.getElementById('pause').textContent = recording.paused ? 'Resume' : 'Pause';
  document.getElementById('pill').classList.toggle('paused', recording.paused);
}

function update(state) {
  recording = state.recording;
  render();
}

api.onState(update);
document.getElementById('stop').addEventListener('click', () => api.recording.requestStop());
document.getElementById('pause').addEventListener('click', () => api.recording.requestPause());
document.getElementById('mark').addEventListener('click', () => api.recording.mark());
setInterval(render, 500);
api.getState().then(update);
