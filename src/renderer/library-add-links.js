'use strict';

// ---------- Add links (the Downloads page's dialog) ----------
// Loaded before library.js and called from it. Pasted links are checked as they are typed (size,
// whether the server can resume them, the file's name, and why one can't be added); the ones
// ticked are added into the chosen folder, to start now, in the queue, or at a set time.
let addChecked = []; // what the main process said about each link
let addSeq = 0;
let addTimer = null;
let addFolderPath = '';

function addSelected() {
  return addChecked.filter((link, index) => link.ok && $('addResults').children[index]?.querySelector('input')?.checked);
}

function addStartMode() {
  return document.querySelector('input[name="addStart"]:checked')?.value ?? 'queue';
}

// The next time the clock shows the time asked for: today, or tomorrow if that has passed.
function nextTimeOfDay(value) {
  const minutes = timeToMinutes(value);
  if (minutes === null) return 0;
  const at = new Date();
  at.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  if (at.getTime() <= Date.now()) at.setDate(at.getDate() + 1);
  return at.getTime();
}

function updateAddForm() {
  const selected = addSelected();
  const mode = addStartMode();
  $('addConfirm').disabled = selected.length === 0 || !addFolderPath;
  $('addConfirm').textContent = selected.length > 0 ? `Add ${selected.length} download${selected.length === 1 ? '' : 's'}` : 'Add downloads';
  $('addStartAt').disabled = mode !== 'at';
  const notes = {
    queue: downloadSettings?.downloadNightOnly ? `They wait for the night (${nightText()}), then start in turn.` : 'They start in turn, as others finish.',
    now: 'They all start at once.',
    at: (() => {
      const at = nextTimeOfDay($('addStartAt').value);
      return at ? `They start ${new Date(at).toDateString() === new Date().toDateString() ? 'today' : 'tomorrow'} at ${new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.` : '';
    })(),
  };
  $('addStartNote').textContent = notes[mode];
  // A checksum belongs to one file.
  const single = selected.length === 1;
  $('addChecksum').disabled = !single;
  $('addChecksumBox').classList.toggle('off', !single);
}

function addResultRow(link) {
  const row = element('li', link.ok ? 'ok' : 'refused');
  const label = element('label');
  const box = element('input');
  box.type = 'checkbox';
  box.checked = link.ok;
  box.disabled = !link.ok;
  box.addEventListener('change', updateAddForm);
  const name = element('span', 'name', link.name || link.url);
  name.title = link.url;
  const info = link.ok
    ? [link.size ? formatBytes(link.size) : 'size unknown', link.resumable ? 'resumable' : 'can’t resume'].join(' · ')
    : link.reason;
  label.append(box, name, element('span', 'info', info));
  row.append(label);
  return row;
}

async function checkAddLinks() {
  const text = $('addLinks').value;
  const seq = ++addSeq;
  if (!text.trim()) {
    addChecked = [];
    $('addCheck').hidden = true;
    updateAddForm();
    return;
  }
  $('addCheck').hidden = false;
  $('addSummary').textContent = 'Checking the links…';
  const results = await api.downloads.checkLinks(text);
  if (seq !== addSeq) return;
  addChecked = results;
  const good = results.filter((link) => link.ok).length;
  $('addSummary').textContent = `${good} of ${results.length} link${results.length === 1 ? '' : 's'} can be downloaded`;
  $('addResults').replaceChildren(...results.map(addResultRow));
  updateAddForm();
}

async function openAddLinks() {
  addChecked = [];
  addSeq += 1;
  $('addLinks').value = '';
  $('addCheck').hidden = true;
  $('addResults').replaceChildren();
  $('addChecksum').value = '';
  $('addChecksumBox').open = false;
  $('addMessage').hidden = true;
  addFolderPath = addFolderPath || await api.downloads.defaultFolder();
  $('addFolder').textContent = addFolderPath;
  if (!downloadSettings) downloadSettings = await api.settings.get();
  updateAddForm();
  $('addDialog').showModal();
  $('addLinks').focus();
}

async function confirmAddLinks() {
  const links = addSelected().map((link) => ({ url: link.url, filename: link.name, total: link.size || 0 }));
  if (links.length === 0) return;
  const mode = addStartMode();
  const request = { links, saveDir: addFolderPath, start: mode };
  if (mode === 'at') request.startAt = nextTimeOfDay($('addStartAt').value);
  if (links.length === 1 && $('addChecksum').value.trim()) request.checksum = $('addChecksum').value.trim();
  const result = await api.downloads.addLinks(request);
  if (!result.ok) {
    $('addMessage').textContent = result.reason === 'folder' ? 'That folder can’t be used. Choose another.' : 'Nothing could be added.';
    $('addMessage').hidden = false;
    return;
  }
  $('addDialog').close();
}

function bindAddLinks() {
  $('addLinks').addEventListener('input', () => {
    clearTimeout(addTimer);
    addTimer = setTimeout(checkAddLinks, 500);
  });
  $('addFolderChange').addEventListener('click', async () => {
    const folder = await api.downloads.chooseFolder();
    if (!folder) return;
    addFolderPath = folder;
    $('addFolder').textContent = folder;
    updateAddForm();
  });
  for (const radio of document.querySelectorAll('input[name="addStart"]')) radio.addEventListener('change', updateAddForm);
  $('addStartAt').addEventListener('change', updateAddForm);
  $('addCancel').addEventListener('click', () => $('addDialog').close());
  $('addConfirm').addEventListener('click', confirmAddLinks);
}
