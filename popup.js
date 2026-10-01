const listEl = document.getElementById('list');
const lastSyncEl = document.getElementById('lastSync');
const addForm = document.getElementById('addForm');
const syncBtn = document.getElementById('syncBtn');

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

// Groups by course code (e.g. "MATH138") rather than the exact course name
// string, since different sources format the same course differently
// ("MATH 138 - Fall 2026" from LEARN vs "MATH 138" from an outline page).
function courseKey(name) {
  if (!name) return 'OTHER';
  const m = name.match(/\b([A-Z]{2,6})\s?(\d{2,4}[A-Z]?)\b/);
  return m ? `${m[1]}${m[2]}`.toUpperCase() : name.trim().toUpperCase();
}

function groupByCourse(deadlines) {
  const groups = new Map(); // key -> { name, items }
  for (const item of deadlines) {
    const key = courseKey(item.courseName);
    if (!groups.has(key)) groups.set(key, { name: item.courseName || 'Other', items: [] });
    const group = groups.get(key);
    if (item.courseName && item.courseName.length > group.name.length) group.name = item.courseName;
    group.items.push(item);
  }
  for (const group of groups.values()) {
    group.items.sort((a, b) => new Date(a.due) - new Date(b.due));
  }
  // Order courses by their soonest upcoming deadline
  return Array.from(groups.values())
    .sort((a, b) => new Date(a.items[0].due) - new Date(b.items[0].due))
    .map((g) => [g.name, g.items]);
}

function renderItemRow(item, now, showCourse) {
  const row = document.createElement('div');
  row.className = 'item';
  const overdue = new Date(item.due).getTime() < now;
  const courseSuffix = showCourse && item.courseName ? ` · ${escapeHtml(item.courseName)}` : '';

  row.innerHTML = `
    <span class="badge ${item.type}">${item.type}</span>
    <div class="info">
      <div class="title">${item.url ? `<a href="${item.url}" target="_blank">${escapeHtml(item.title)}</a>` : escapeHtml(item.title)}</div>
      <div class="due ${overdue ? 'overdue' : ''}">${fmtDue(item.due)}${courseSuffix}</div>
    </div>
    <button class="remove" data-id="${item.id}" title="Remove">&times;</button>
  `;
  return row;
}

const DUE_SOON_MS = 14 * 24 * 60 * 60 * 1000;

function render(deadlines) {
  const now = Date.now();
  listEl.innerHTML = '';

  if (deadlines.length === 0) {
    listEl.innerHTML = '<div class="empty">No deadlines yet. Visit a course\'s Dropbox or Quizzes page, or add one below.</div>';
    return;
  }

  const dueSoon = deadlines
    .filter((d) => {
      const t = new Date(d.due).getTime();
      return t >= now - 60 * 60 * 1000 && t <= now + DUE_SOON_MS;
    })
    .sort((a, b) => new Date(a.due) - new Date(b.due));

  if (dueSoon.length > 0) {
    const section = document.createElement('div');
    section.className = 'due-soon-section';
    const header = document.createElement('div');
    header.className = 'section-header';
    header.textContent = `Due in the next 2 weeks (${dueSoon.length})`;
    section.appendChild(header);
    dueSoon.forEach((item) => section.appendChild(renderItemRow(item, now, true)));
    listEl.appendChild(section);
  }

  const groups = groupByCourse(deadlines);
  const allSection = document.createElement('div');
  allSection.className = 'all-courses-section';
  const allHeader = document.createElement('div');
  allHeader.className = 'section-header';
  allHeader.textContent = 'All courses';
  allSection.appendChild(allHeader);

  for (const [courseName, items] of groups) {
    const details = document.createElement('details');
    details.className = 'course-group';

    const summary = document.createElement('summary');
    summary.className = 'course-header';
    summary.textContent = `${courseName} (${items.length})`;
    details.appendChild(summary);

    items.forEach((item) => details.appendChild(renderItemRow(item, now, false)));
    allSection.appendChild(details);
  }
  listEl.appendChild(allSection);

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
  const courseName = document.getElementById('courseInput').value.trim() || null;
  const title = document.getElementById('titleInput').value.trim();
  const type = document.getElementById('typeInput').value;
  const dueRaw = document.getElementById('dueInput').value;
  if (!title || !dueRaw) return;

  const due = new Date(dueRaw).toISOString();
  const id = 'manual-' + crypto.randomUUID();

  const { deadlines = [] } = await chrome.storage.local.get('deadlines');
  deadlines.push({ id, title, type, due, source: 'manual', url: null, courseId: null, courseName });
  await chrome.storage.local.set({ deadlines });

  addForm.reset();
  load();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.deadlines || changes.lastScrapeAt)) load();
});

syncBtn.addEventListener('click', async () => {
  syncBtn.disabled = true;
  syncBtn.textContent = '…';
  try {
    await chrome.runtime.sendMessage({ type: 'manual-sync' });
  } catch (e) {
    // service worker may be asleep momentarily; ignore
  }
  await load();
  syncBtn.disabled = false;
  syncBtn.textContent = '↻';
});

load();
