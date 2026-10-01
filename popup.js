const listEl = document.getElementById('list');
const lastSyncEl = document.getElementById('lastSync');
const addForm = document.getElementById('addForm');

function fmtDue(iso) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

function render(deadlines) {
  const now = Date.now();
  const sorted = [...deadlines].sort((a, b) => new Date(a.due) - new Date(b.due));

  listEl.innerHTML = '';
  if (sorted.length === 0) {
    listEl.innerHTML = '<div class="empty">No deadlines yet. Visit your LEARN Calendar page, or add one below.</div>';
    return;
  }

  for (const item of sorted) {
    const row = document.createElement('div');
    row.className = 'item';

    const overdue = new Date(item.due).getTime() < now;

    row.innerHTML = `
      <span class="badge ${item.type}">${item.type}</span>
      <div class="info">
        <div class="title">${item.url ? `<a href="${item.url}" target="_blank">${escapeHtml(item.title)}</a>` : escapeHtml(item.title)}</div>
        <div class="due ${overdue ? 'overdue' : ''}">${fmtDue(item.due)}</div>
      </div>
      <button class="remove" data-id="${item.id}" title="Remove">&times;</button>
    `;
    listEl.appendChild(row);
  }

  listEl.querySelectorAll('button.remove').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const { deadlines = [] } = await chrome.storage.local.get('deadlines');
      const updated = deadlines.filter((d) => d.id !== btn.dataset.id);
      await chrome.storage.local.set({ deadlines: updated });
      load();
    });
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

async function load() {
  const { deadlines = [], lastScrapeAt } = await chrome.storage.local.get(['deadlines', 'lastScrapeAt']);
  render(deadlines);
  lastSyncEl.textContent = lastScrapeAt
    ? `synced ${new Date(lastScrapeAt).toLocaleTimeString()}`
    : 'not synced yet';
}

addForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = document.getElementById('titleInput').value.trim();
  const type = document.getElementById('typeInput').value;
  const dueRaw = document.getElementById('dueInput').value;
  if (!title || !dueRaw) return;

  const due = new Date(dueRaw).toISOString();
  const id = 'manual-' + crypto.randomUUID();

  const { deadlines = [] } = await chrome.storage.local.get('deadlines');
  deadlines.push({ id, title, type, due, source: 'manual', url: null, courseId: null });
  await chrome.storage.local.set({ deadlines });

  addForm.reset();
  load();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.deadlines || changes.lastScrapeAt)) load();
});

load();
