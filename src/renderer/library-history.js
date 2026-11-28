'use strict';

// ---------- History ----------
// Visits are shown by day (Today, Yesterday, then each earlier day), newest first, and a search
// keeps the days. A day can be deleted at once, after asking on the page.
const DAY_MS = 24 * 60 * 60 * 1000;
const startOfDay = (time) => {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
};
// The next midnight (not always 24 hours later, when the clocks change).
const nextDay = (start) => startOfDay(start + DAY_MS + 3 * 60 * 60 * 1000);

function dayLabel(start, now = Date.now()) {
  const today = startOfDay(now);
  if (start === today) return 'Today';
  if (start === startOfDay(today - 12 * 60 * 60 * 1000)) return 'Yesterday';
  const sameYear = new Date(start).getFullYear() === new Date(now).getFullYear();
  return new Date(start).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', ...(sameYear ? {} : { year: 'numeric' }) });
}

// Newest first in, days newest first out: [{ start, end, entries }].
function groupByDay(entries) {
  const days = [];
  for (const entry of entries) {
    const start = startOfDay(entry.time);
    if (days.at(-1)?.start !== start) days.push({ start, end: nextDay(start), entries: [] });
    days.at(-1).entries.push(entry);
  }
  return days;
}

const formatTime = (time) => new Date(time).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

function historyRow(entry) {
  const row = element('div', 'row');
  const main = element('div', 'main');
  const open = button(entry.title || entry.url, () => api.tabs.open(entry.url), 'title');
  open.title = entry.url;
  main.append(open, element('div', 'meta', `${formatTime(entry.time)}  ·  ${entry.url}`));
  const actions = element('div', 'actions');
  actions.append(button('Remove', async () => { await api.history.remove(entry.id); loadHistory(); }));
  row.append(main, actions);
  return row;
}

// "Delete this day" asks on the page first. While searching, only the pages found are deleted.
function dayHeader(day, searching) {
  const header = element('div', 'day-header');
  const label = dayLabel(day.start);
  header.append(element('h3', '', label));
  const tools = element('div', 'day-tools');
  const ask = () => {
    const when = label === 'Today' || label === 'Yesterday' ? label.toLowerCase() : `on ${label}`;
    const count = day.entries.length;
    const what = searching ? `Delete the ${count} page${count === 1 ? '' : 's'} found ${when}?` : `Delete every page visited ${when}?`;
    const confirm = button('Delete', async () => {
      if (searching) {
        for (const entry of day.entries) await api.history.remove(entry.id);
      } else {
        await api.history.removeRange(day.start, day.end);
      }
      loadHistory();
    }, 'danger');
    tools.replaceChildren(element('span', 'confirm-text', what), confirm, button('Cancel', () => tools.replaceChildren(start)));
    confirm.focus();
  };
  const start = button(searching ? 'Delete these' : 'Delete this day', ask, 'day-delete');
  tools.append(start);
  header.append(tools);
  return header;
}

async function loadHistory() {
  const query = $('historySearch').value.trim();
  const { enabled, entries } = await api.history.list(query);
  $('historyOff').hidden = enabled;
  const list = $('historyList');
  list.replaceChildren();
  if (entries.length === 0) {
    list.append(element('p', 'empty', query ? 'No matching pages.' : 'No history yet.'));
    return;
  }
  for (const day of groupByDay(entries)) {
    const section = element('section', 'day');
    section.dataset.day = String(day.start);
    section.append(dayHeader(day, Boolean(query)), ...day.entries.map(historyRow));
    list.append(section);
  }
}
