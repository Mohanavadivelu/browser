'use strict';

// ---------- Settings ----------
function fillSelect(select, options, value) {
  select.replaceChildren(...options.map(({ key, label }) => {
    const option = element('option', undefined, label);
    option.value = key;
    return option;
  }));
  select.value = value;
}

function renderSettings(settings) {
  $('homePage').value = settings.homePage;
  fillSelect($('searchEngine'), settings.engines.map((engine) => ({ key: engine.key, label: engine.name })), settings.searchEngine);
  $('restoreTabs').checked = settings.restoreTabs;
  fillSelect($('memorySaverMinutes'), settings.memorySaverChoices.map((minutes) => ({
    key: String(minutes),
    label: minutes === 0 ? 'Never (memory saver off)' : minutes < 60 ? `${minutes} minutes` : `${minutes / 60} hour${minutes === 60 ? '' : 's'}`,
  })), String(settings.memorySaverMinutes));
  $('historyEnabled').checked = settings.historyEnabled;
  fillSelect($('recordingQuality'), settings.qualities.map((quality) => ({ key: quality.key, label: quality.label })), settings.recordingQuality);
  $('qualityHint').textContent = settings.qualities.find((quality) => quality.key === settings.recordingQuality)?.description ?? '';
  $('recordingFollowTab').checked = settings.recordingFollowTab;
  $('showBookmarksBar').checked = settings.showBookmarksBar;
  $('recordingMicrophone').checked = settings.recordingMicrophone;
  fillSelect($('recordingStopAfter'), settings.stopAfterChoices.map((minutes) => ({
    key: String(minutes),
    label: minutes === 0 ? 'Never' : minutes < 60 || minutes % 60 ? `${minutes} minutes` : `${minutes / 60} hour${minutes === 60 ? '' : 's'}`,
  })), String(settings.recordingStopAfter));
  $('blockTrackers').checked = settings.blockTrackers;
  $('checkForUpdates').checked = settings.checkForUpdates;
  fillSelect($('downloadsAtOnce'), settings.downloadsAtOnceChoices.map((count) => ({ key: String(count), label: String(count) })), String(settings.downloadsAtOnce));
  $('resumeDownloads').checked = settings.resumeDownloads;
  fillSelect($('connectionsPerFile'), settings.connectionsChoices.map((count) => ({ key: String(count), label: count === 1 ? '1 (never split)' : String(count) })), String(settings.connectionsPerFile));
  $('speedLimitNone').checked = settings.speedLimitKBps === 0;
  $('speedLimitOn').checked = settings.speedLimitKBps > 0;
  if (settings.speedLimitKBps > 0) $('speedLimitValue').value = String(Math.round((settings.speedLimitKBps / 1024) * 10) / 10);
  else if (!$('speedLimitValue').value) $('speedLimitValue').value = '5';
  $('markOfTheWeb').checked = settings.markOfTheWeb;
  $('downloadNightOnly').checked = settings.downloadNightOnly;
  $('downloadNightFrom').value = minutesToTime(settings.downloadNightFrom);
  $('downloadNightTo').value = minutesToTime(settings.downloadNightTo);
  showDownloadSettings(settings);
  const sites = $('allowedSites');
  sites.replaceChildren();
  if (settings.blockerAllowedSites.length === 0) sites.append(element('p', 'empty', 'None.'));
  for (const site of settings.blockerAllowedSites) {
    const row = element('div', 'row');
    row.dataset.site = site;
    const main = element('div', 'main');
    main.append(element('div', 'name', site));
    const actions = element('div', 'actions');
    actions.append(button('Block again', async () => renderSettings(await api.blocker.removeSite(site))));
    row.append(main, actions);
    sites.append(row);
  }
  $('folderPath').textContent = settings.recordingFolder;
  $('spellcheck').checked = settings.spellcheck;
  $('darkPages').checked = settings.darkPages;
  $('darkSitesField').hidden = !settings.darkPages;
  const darkSites = $('darkSites');
  darkSites.replaceChildren();
  if (settings.darkPagesLight.length === 0) darkSites.append(element('p', 'empty', 'None.'));
  for (const site of settings.darkPagesLight) {
    const row = element('div', 'row');
    row.dataset.site = site;
    const main = element('div', 'main');
    main.append(element('div', 'name', site));
    const actions = element('div', 'actions');
    actions.append(button('Make dark again', async () => renderSettings(await api.settings.removeDarkSite(site))));
    row.append(main, actions);
    darkSites.append(row);
  }
}

// ---------- Back up and restore ----------
const RESTORE_PARTS = [
  { key: 'bookmarks', label: (n) => `Bookmarks (${plural(n.bookmarks, 'bookmark')}, ${plural(n.folders, 'folder')})`, has: (n) => n.bookmarks + n.folders > 0 },
  { key: 'settings', label: () => 'Settings', has: () => true },
  { key: 'pinnedTabs', label: (n) => `Pinned tabs (${n.pinnedTabs})`, has: (n) => n.pinnedTabs > 0 },
  { key: 'downloads', label: (n) => `Downloads list (${n.downloads})`, has: (n) => n.downloads > 0 },
  { key: 'history', label: (n) => `History (${plural(n.history, 'visit')})`, has: (n) => n.history > 0 },
];
const BACKUP_PROBLEMS = {
  'too-large': 'That file is too large to be a backup.',
  'not-json': 'That file is not a Simple Browser backup.',
  'not-a-backup': 'That file is not a Simple Browser backup.',
  'newer-version': 'That backup was made by a newer version of Simple Browser. Update the browser to restore it.',
  unreadable: 'That file could not be read.',
};

function backupMessage(text, warn = false) {
  const node = $('backupMessage');
  node.textContent = text;
  node.classList.toggle('warn', warn);
  node.hidden = !text;
}

function showRestorePreview(result) {
  const created = result.createdAt ? new Date(result.createdAt).toLocaleString() : 'an unknown date';
  const by = result.appVersion ? ` by version ${result.appVersion}` : '';
  $('restoreSummary').textContent = `${result.file}: made on ${created}${by}. Choose what to restore:`;
  const parts = $('restoreParts');
  parts.replaceChildren();
  for (const part of RESTORE_PARTS) {
    if (!part.has(result.counts)) continue;
    const label = element('label', 'check');
    const box = element('input');
    box.type = 'checkbox';
    box.checked = true;
    box.dataset.part = part.key;
    label.append(box, ` ${part.label(result.counts)}`);
    parts.append(label);
  }
  $('restorePreview').hidden = false;
  $('restoreConfirm').focus();
}

function restoredText(done) {
  const said = [
    done.bookmarks !== undefined && plural(done.bookmarks, 'bookmark'),
    done.settings !== undefined && 'your settings',
    done.pinnedTabs !== undefined && `${plural(done.pinnedTabs, 'pinned tab')} opened`,
    done.downloads !== undefined && `${plural(done.downloads, 'download')} added`,
    done.history !== undefined && `${plural(done.history, 'visit')} added to history`,
  ].filter(Boolean);
  return `Restored ${said.join(', ')}.`;
}

function bindBackup() {
  $('backupSave').addEventListener('click', async () => {
    const result = await api.settings.backupSave($('backupHistory').checked);
    if (result.canceled) return;
    if (!result.ok) return backupMessage(`The backup could not be saved: ${result.message}`, true);
    const withHistory = result.history === null ? '' : `, with ${plural(result.history, 'visit')} of history`;
    backupMessage(`Backed up to ${result.path}${withHistory}.`);
  });
  $('backupOpen').addEventListener('click', async () => {
    $('restorePreview').hidden = true;
    backupMessage('');
    const result = await api.settings.backupOpen();
    if (result.canceled) return;
    if (!result.ok) return backupMessage(BACKUP_PROBLEMS[result.reason] ?? 'That file could not be restored.', true);
    showRestorePreview(result);
  });
  $('restoreCancel').addEventListener('click', () => {
    $('restorePreview').hidden = true;
    api.settings.backupCancel();
  });
  $('restoreConfirm').addEventListener('click', async () => {
    const parts = {};
    for (const box of $('restoreParts').querySelectorAll('input[data-part]')) parts[box.dataset.part] = box.checked;
    if (!Object.values(parts).some(Boolean)) return backupMessage('Choose at least one thing to restore.', true);
    const result = await api.settings.backupRestore(parts);
    $('restorePreview').hidden = true;
    if (!result.ok) return backupMessage('Open the backup again to restore it.', true);
    renderSettings(result.settings);
    backupMessage(restoredText(result.done));
  });
}

async function saveSetting(patch) {
  renderSettings(await api.settings.update(patch));
}

function bindSettings() {
  $('homePage').addEventListener('change', () => saveSetting({ homePage: $('homePage').value.trim() }));
  $('searchEngine').addEventListener('change', () => saveSetting({ searchEngine: $('searchEngine').value }));
  $('restoreTabs').addEventListener('change', () => saveSetting({ restoreTabs: $('restoreTabs').checked }));
  $('memorySaverMinutes').addEventListener('change', () => saveSetting({ memorySaverMinutes: Number($('memorySaverMinutes').value) }));
  $('historyEnabled').addEventListener('change', () => saveSetting({ historyEnabled: $('historyEnabled').checked }));
  $('blockTrackers').addEventListener('change', () => saveSetting({ blockTrackers: $('blockTrackers').checked }));
  $('checkForUpdates').addEventListener('change', () => saveSetting({ checkForUpdates: $('checkForUpdates').checked }));
  $('downloadsAtOnce').addEventListener('change', () => saveSetting({ downloadsAtOnce: Number($('downloadsAtOnce').value) }));
  $('resumeDownloads').addEventListener('change', () => saveSetting({ resumeDownloads: $('resumeDownloads').checked }));
  $('connectionsPerFile').addEventListener('change', () => saveSetting({ connectionsPerFile: Number($('connectionsPerFile').value) }));
  // The limit is typed in MB/s and kept in KB/s.
  const saveLimit = () => {
    const megabytes = Number($('speedLimitValue').value);
    const kilobytes = Number.isFinite(megabytes) && megabytes > 0 ? Math.min(10 * 1024 * 1024, Math.max(1, Math.round(megabytes * 1024))) : 0;
    saveSetting({ speedLimitKBps: $('speedLimitOn').checked ? kilobytes : 0 });
  };
  $('speedLimitNone').addEventListener('change', saveLimit);
  $('speedLimitOn').addEventListener('change', saveLimit);
  $('speedLimitValue').addEventListener('change', () => {
    $('speedLimitOn').checked = true;
    saveLimit();
  });
  $('markOfTheWeb').addEventListener('change', () => saveSetting({ markOfTheWeb: $('markOfTheWeb').checked }));
  $('downloadNightOnly').addEventListener('change', () => saveSetting({ downloadNightOnly: $('downloadNightOnly').checked }));
  for (const id of ['downloadNightFrom', 'downloadNightTo']) {
    $(id).addEventListener('change', () => {
      const minutes = timeToMinutes($(id).value);
      if (minutes !== null) saveSetting({ [id]: minutes });
    });
  }
  $('updatesCheck').addEventListener('click', async () => {
    $('updatesMessage').textContent = 'Checking…';
    const result = await api.updates.check();
    const messages = {
      'up-to-date': 'You have the latest version.',
      available: `Version ${result.version} is available: download it from the ⋮ menu.`,
      downloading: `Downloading version ${result.version}…`,
      ready: `Version ${result.version} is ready: restart from the ⋮ menu.`,
      error: 'Could not check for updates.',
    };
    $('updatesMessage').textContent = result.mode === 'off' ? 'Updates are not checked when running from source.' : messages[result.status] ?? '';
  });
  $('recordingQuality').addEventListener('change', () => saveSetting({ recordingQuality: $('recordingQuality').value }));
  $('recordingStopAfter').addEventListener('change', () => saveSetting({ recordingStopAfter: Number($('recordingStopAfter').value) }));
  $('recordingMicrophone').addEventListener('change', () => saveSetting({ recordingMicrophone: $('recordingMicrophone').checked }));
  $('showBookmarksBar').addEventListener('change', () => saveSetting({ showBookmarksBar: $('showBookmarksBar').checked }));
  $('recordingFollowTab').addEventListener('change', () => saveSetting({ recordingFollowTab: $('recordingFollowTab').checked }));
  $('folderChange').addEventListener('click', async () => renderSettings(await api.settings.chooseFolder()));
  $('folderOpen').addEventListener('click', () => api.recordings.openFolder());
  $('spellcheck').addEventListener('change', () => saveSetting({ spellcheck: $('spellcheck').checked }));
  $('darkPages').addEventListener('change', () => saveSetting({ darkPages: $('darkPages').checked }));
  bindBackup();
}
