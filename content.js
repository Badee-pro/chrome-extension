// Scrapes deadlines from classic D2L Brightspace tool pages:
//  - Dropbox Folders list  (/d2l/lms/dropbox/user/folders_list.d2l)
//  - Quiz List             (/d2l/lms/quizzing/user/quizzes_list.d2l)
//  - Course/My Home "Work To Do" widget (/d2l/home...)
//
// These are plain server-rendered HTML (no shadow DOM), so this is a
// straightforward table/text scrape. If Waterloo changes the markup, tune
// the regexes below and reload the page (DEBUG logs what was found).

const DEBUG = true;

function getCourseName() {
  // Page <title> is "<Tool Name> - <Course Name>", e.g.
  // "Dropbox Folders - PD 1 Online - Fall 2026"
  const parts = document.title.split(' - ');
  return parts.length > 1 ? parts.slice(1).join(' - ').trim() : null;
}

function getCourseId() {
  return new URLSearchParams(location.search).get('ou');
}

function classify(title, toolType) {
  if (toolType === 'quiz') return 'quiz';
  if (toolType === 'dropbox') return 'assignment';
  if (/\bquiz\b|\btest\b|\bexam\b/i.test(title)) return 'quiz';
  if (/\bassignment\b|\bdropbox\b|\bhomework\b|\blab\b/i.test(title)) return 'assignment';
  return 'other';
}

const FULL_DATE_RE =
  /Due on\s+([A-Z][a-z]{2,8}\s+\d{1,2},\s*\d{4})\s+(\d{1,2}:\d{2}\s*[AP]M)/;

// "Due Oct 9" / "End Oct 3" (Work To Do widget, no year/time given)
const SHORT_DATE_RE = /\b(Due|End)\s+([A-Z][a-z]{2,8})\s+(\d{1,2})\b/;

function parseFullDate(text) {
  const m = text.match(FULL_DATE_RE);
  if (!m) return null;
  const d = new Date(`${m[1]} ${m[2]}`);
  return isNaN(d.getTime()) ? null : d;
}

function parseShortDate(text) {
  const m = text.match(SHORT_DATE_RE);
  if (!m) return null;
  const now = new Date();
  let year = now.getFullYear();
  let d = new Date(`${m[2]} ${m[3]}, ${year} 23:59:00`);
  if (isNaN(d.getTime())) return null;
  // If the parsed date is more than ~30 days in the past, it's probably
  // next year's occurrence of that month/day.
  if (d.getTime() < now.getTime() - 30 * 24 * 60 * 60 * 1000) {
    d = new Date(`${m[2]} ${m[3]}, ${year + 1} 23:59:00`);
  }
  return d;
}

function scrapeTable(toolType) {
  const courseName = getCourseName();
  const courseId = getCourseId();
  const rows = document.querySelectorAll('table tr');
  const results = [];

  rows.forEach((row) => {
    const link = row.querySelector('a');
    if (!link) return;
    const title = link.textContent.trim();
    if (!title) return;

    const due = parseFullDate(row.textContent || '');
    if (!due) return;

    results.push({
      id: `${courseId}:${toolType}:${title}:${due.toISOString()}`,
      title,
      type: classify(title, toolType),
      due: due.toISOString(),
      courseId,
      courseName,
      url: link.href || location.href,
      source: 'scrape',
      scrapeKey: `${courseId}:${toolType}`
    });
  });

  return results;
}

function scrapeWorkToDo() {
  const courseName = getCourseName();
  const courseId = getCourseId();
  const links = Array.from(document.querySelectorAll('a')).filter(
    (a) => a.textContent.trim().length > 0
  );

  const results = [];
  for (const link of links) {
    const container = link.closest('li, tr, div') || link.parentElement;
    if (!container) continue;
    const text = container.textContent || '';
    const due = parseShortDate(text);
    if (!due) continue;

    const title = link.textContent.trim();
    results.push({
      id: `${courseId}:worktodo:${title}:${due.toISOString()}`,
      title,
      type: classify(title, 'worktodo'),
      due: due.toISOString(),
      courseId,
      courseName,
      url: link.href || location.href,
      source: 'scrape',
      scrapeKey: `${courseId}:worktodo`
    });
  }

  // De-dupe by id (same item can match via multiple ancestor containers)
  const byId = new Map();
  results.forEach((r) => byId.set(r.id, r));
  return Array.from(byId.values());
}

function detectToolType() {
  if (location.pathname.includes('/lms/dropbox/')) return 'dropbox';
  if (location.pathname.includes('/lms/quizzing/')) return 'quiz';
  if (location.pathname.includes('/d2l/home')) return 'worktodo';
  return null;
}

async function sync() {
  const toolType = detectToolType();
  if (!toolType) return;

  const scraped = toolType === 'worktodo' ? scrapeWorkToDo() : scrapeTable(toolType);
  if (DEBUG) console.log('[LEARN Deadline Tracker] scraped', toolType, scraped.length, 'items', scraped);

  if (scraped.length === 0) return;

  const scrapeKeys = new Set(scraped.map((s) => s.scrapeKey));
  const { deadlines = [] } = await chrome.storage.local.get('deadlines');
  const kept = deadlines.filter(
    (d) => d.source === 'manual' || !scrapeKeys.has(d.scrapeKey)
  );
  const merged = [...kept, ...scraped];

  await chrome.storage.local.set({ deadlines: merged, lastScrapeAt: new Date().toISOString() });
  chrome.runtime.sendMessage({ type: 'deadlines-updated' }).catch(() => {});
}

// Brightspace can render table/widget content slightly after document_idle,
// so retry a few times instead of scraping once.
let attempts = 0;
const interval = setInterval(() => {
  attempts += 1;
  sync();
  if (attempts >= 5) clearInterval(interval);
}, 1500);
