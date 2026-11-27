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
}

async function saveSetting(patch) {
  renderSettings(await api.settings.update(patch));
}

function bindSettings() {
  $('homePage').addEventListener('change', () => saveSetting({ homePage: $('homePage').value.trim() }));
  $('searchEngine').addEventListener('change', () => saveSetting({ searchEngine: $('searchEngine').value }));
  $('restoreTabs').addEventListener('change', () => saveSetting({ restoreTabs: $('restoreTabs').checked }));
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
  $('settingsClearHistory').addEventListener('click', async () => {
    await api.history.clear();
    $('settingsHistoryMsg').textContent = 'History cleared.';
    $('settingsHistoryMsg').hidden = false;
  });
}
