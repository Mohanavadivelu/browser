'use strict';

// ---------- Recordings ----------
function showRecordingMessage(text) {
  $('recMessage').textContent = text;
  $('recMessage').hidden = !text;
}

const RENAME_ERRORS = {
  exists: 'A file with that name already exists.',
  'invalid-name': 'That name is not allowed.',
  failed: 'The file could not be renamed.',
};

function startRename(row, entry) {
  const main = row.querySelector('.main');
  const dot = entry.name.lastIndexOf('.');
  const input = element('input');
  input.type = 'text';
  input.value = dot > 0 ? entry.name.slice(0, dot) : entry.name;
  input.maxLength = 100;
  main.replaceChildren(input);
  input.focus();
  input.select();

  const actions = row.querySelector('.actions');
  const save = async () => {
    const result = await api.recordings.rename(entry.name, input.value);
    if (result.ok) {
      showRecordingMessage('');
      loadRecordings();
    } else {
      showRecordingMessage(RENAME_ERRORS[result.reason] ?? RENAME_ERRORS.failed);
    }
  };
  actions.replaceChildren(button('Save', save), button('Cancel', () => { showRecordingMessage(''); loadRecordings(); }));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') save();
    else if (event.key === 'Escape') loadRecordings();
  });
}

function deleteButton(entry) {
  const node = button('Delete', async () => {
    if (!node.dataset.confirm) {
      node.dataset.confirm = '1';
      node.textContent = 'Click again to delete';
      setTimeout(() => { delete node.dataset.confirm; node.textContent = 'Delete'; }, 3000);
      return;
    }
    const result = await api.recordings.delete(entry.name);
    showRecordingMessage(result.ok ? '' : 'The file could not be deleted.');
    loadRecordings();
  }, 'danger');
  return node;
}

// ---------- Thumbnails and the player ----------
// A thumbnail loads its file only once it scrolls into view; a video shows a frame from about a
// second in.
const thumbObserver = new IntersectionObserver((seen) => {
  for (const item of seen) {
    if (!item.isIntersecting) continue;
    thumbObserver.unobserve(item.target);
    const media = item.target.firstElementChild;
    media.src = media.dataset.src;
  }
});

function thumbnail(entry) {
  const node = element('button', 'thumb');
  node.type = 'button';
  node.title = entry.type === 'video' ? `Play ${entry.name}` : `View ${entry.name}`;
  let media;
  if (entry.type === 'video') {
    media = element('video');
    media.muted = true;
    media.preload = 'metadata';
    media.addEventListener('loadedmetadata', () => {
      media.currentTime = Number.isFinite(media.duration) ? Math.min(1, media.duration / 2) : 1;
    }, { once: true });
  } else {
    media = element('img');
    media.alt = '';
  }
  media.dataset.src = entry.url;
  node.append(media);
  node.addEventListener('click', () => openPlayer(entry));
  thumbObserver.observe(node);
  return node;
}

let playerEntry = null;
let trim = { start: 0, end: 0 };

// "1:05.3": the times shown while trimming, to a tenth of a second.
function formatTrimTime(ms) {
  const tenths = Math.round(ms / 100);
  const minutes = Math.floor(tenths / 600);
  const seconds = (tenths % 600) / 10;
  return `${minutes}:${seconds < 10 ? '0' : ''}${seconds.toFixed(1)}`;
}

function showTrim() {
  $('trimStart').textContent = formatTrimTime(trim.start);
  $('trimEnd').textContent = formatTrimTime(trim.end);
  $('trimSave').disabled = trim.end <= trim.start;
}

const TRIM_ERRORS = {
  recording: 'This recording is still being recorded.',
  'invalid-range': 'The end must come after the start.',
};

async function saveTrim() {
  const entry = playerEntry;
  $('trimSave').disabled = true;
  $('playerInfo').textContent = 'Saving the trimmed copy…';
  const result = await api.recordings.trim(entry.name, Math.round(trim.start), Math.round(trim.end));
  if (result.ok) {
    $('playerInfo').textContent = `Saved ${result.name} (${formatDuration(result.durationMs)}). It starts at ${formatTrimTime(result.startMs)}, the keyframe at or before your start.`;
    loadRecordings();
  } else {
    $('playerInfo').textContent = TRIM_ERRORS[result.reason] ?? `Could not save the trimmed copy${result.message ? `: ${result.message}` : '.'}`;
  }
  showTrim();
}

function openPlayer(entry) {
  playerEntry = entry;
  const stage = $('playerStage');
  let media;
  if (entry.type === 'video') {
    media = element('video');
    media.controls = true;
    media.autoplay = true;
    media.addEventListener('loadedmetadata', () => {
      $('playerInfo').textContent = Number.isFinite(media.duration) ? `Length ${formatDuration(media.duration * 1000)}` : '';
      trim = { start: 0, end: Number.isFinite(media.duration) ? media.duration * 1000 : 0 };
      showTrim();
      $('trimBar').hidden = false;
    });
  } else {
    media = element('img');
    media.alt = entry.name;
  }
  media.id = 'playerMedia';
  media.src = entry.url;
  stage.replaceChildren(media);
  $('playerTitle').textContent = entry.name;
  $('playerInfo').textContent = '';
  $('trimBar').hidden = true;
  // Markers set while recording: each jumps to its moment.
  const markers = entry.type === 'video' ? entry.markers ?? [] : [];
  $('playerMarkers').replaceChildren(...markers.map((ms, i) => {
    const chip = button(`Marker ${i + 1} · ${formatTrimTime(ms)}`, () => { media.currentTime = ms / 1000; });
    chip.title = `Jump to marker ${i + 1}`;
    return chip;
  }));
  $('playerMarkers').hidden = markers.length === 0;
  $('player').hidden = false;
  $('playerClose').focus();
}

function closePlayer() {
  const media = $('playerMedia');
  if (media?.pause) media.pause();
  $('playerStage').replaceChildren();
  $('player').hidden = true;
  playerEntry = null;
}

async function loadRecordings() {
  const { folder, entries } = await api.recordings.list();
  $('recFolder').textContent = folder;
  const list = $('recList');
  list.replaceChildren();
  if (entries.length === 0) {
    list.append(element('p', 'empty', 'No recordings or screenshots yet. Use ● to record or 📷 for a screenshot.'));
    return;
  }
  // Recordings that followed you across tabs: "x.webm", "x-part2.webm", ... can be joined.
  const partCount = new Map();
  for (const entry of entries) {
    const match = /^(.+?)(?:-part(\d+))?\.webm$/i.exec(entry.name);
    if (match) partCount.set(match[1], (partCount.get(match[1]) ?? 0) + 1);
  }
  for (const entry of entries) {
    const row = element('div', 'row');
    row.dataset.name = entry.name;
    row.append(thumbnail(entry));
    const main = element('div', 'main');
    main.append(element('div', 'name', entry.name));
    const parts = [];
    if (entry.type === 'video' && entry.durationMs !== null) parts.push(formatDuration(entry.durationMs));
    if (entry.markers?.length) parts.push(`${entry.markers.length} marker${entry.markers.length === 1 ? '' : 's'}`);
    parts.push(formatBytes(entry.size), formatDate(entry.modified));
    main.append(element('div', 'meta', parts.join('  ·  ')));
    const actions = element('div', 'actions');
    actions.append(
      button(entry.type === 'video' ? 'Play' : 'View', () => openPlayer(entry)),
      button('Open', async () => { if (!(await api.recordings.open(entry.name))) showRecordingMessage('The file could not be opened.'); }),
      button('Show in folder', () => api.recordings.reveal(entry.name)),
      button('Rename', () => startRename(row, entry)),
      deleteButton(entry),
    );
    const base = /^(.+?)\.webm$/i.exec(entry.name)?.[1];
    if (base && !/-part\d+$/i.test(base) && (partCount.get(base) ?? 0) > 1) {
      const join = button(`Join ${partCount.get(base)} parts`, async () => {
        join.disabled = true;
        join.textContent = 'Joining…';
        const result = await api.recordings.join(entry.name);
        showRecordingMessage(result.ok
          ? `Joined ${result.parts} parts into ${result.name} (${formatDuration(result.durationMs)}).`
          : TRIM_ERRORS[result.reason] ?? `Could not join the parts${result.message ? `: ${result.message}` : '.'}`);
        loadRecordings();
      }, 'primary');
      actions.prepend(join);
    }
    row.append(main, actions);
    list.append(row);
  }
}
