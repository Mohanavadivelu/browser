'use strict';

// ---------- History ----------
async function loadHistory() {
  const { enabled, entries } = await api.history.list($('historySearch').value.trim());
  $('historyOff').hidden = enabled;
  const list = $('historyList');
  list.replaceChildren();
  if (entries.length === 0) {
    list.append(element('p', 'empty', $('historySearch').value ? 'No matching pages.' : 'No history yet.'));
    return;
  }
  for (const entry of entries) {
    const row = element('div', 'row');
    const main = element('div', 'main');
    const open = button(entry.title || entry.url, () => api.tabs.open(entry.url), 'title');
    open.title = entry.url;
    main.append(open, element('div', 'meta', `${entry.url}  ·  ${formatDate(entry.time)}`));
    const actions = element('div', 'actions');
    actions.append(button('Remove', async () => { await api.history.remove(entry.id); loadHistory(); }));
    row.append(main, actions);
    list.append(row);
  }
}
