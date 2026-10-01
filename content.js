// Scrapes deadlines from the LEARN page currently open in the tab, and
// registers the course (id + name) so the background service worker can
// keep refreshing it automatically from then on, without needing this page
// to be revisited manually. Relies on common.js (loaded first).

function getCourseName() {
  // Page <title> is "<Tool Name> - <Course Name>", e.g.
  // "Dropbox Folders - PD 1 Online - Fall 2026"
  const parts = document.title.split(' - ');
  return parts.length > 1 ? parts.slice(1).join(' - ').trim() : null;
}

function getCourseId() {
  const q = new URLSearchParams(location.search).get('ou');
  if (q) return q;
  const m = location.pathname.match(/\/d2l\/home\/(\d+)/);
  return m ? m[1] : null;
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

    const due = parseFullDateFromText(row.textContent || '');
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

// "Due Oct 9" / "End Oct 3" (Work To Do widget, no year/time given)
const SHORT_DATE_RE = /\b(Due|End)\s+([A-Z][a-z]{2,8})\s+(\d{1,2})\b/;

function parseShortDate(text) {
  const m = text.match(SHORT_DATE_RE);
  if (!m) return null;
  const now = new Date();
  const year = now.getFullYear();
  let d = new Date(`${m[2]} ${m[3]}, ${year} 23:59:00`);
  if (isNaN(d.getTime())) return null;
  if (d.getTime() < now.getTime() - 30 * 24 * 60 * 60 * 1000) {
    d = new Date(`${m[2]} ${m[3]}, ${year + 1} 23:59:00`);
  }
  return d;
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
    const due = parseShortDate(container.textContent || '');
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

  const courseId = getCourseId();
  const courseName = getCourseName();
  if (courseId && courseName) {
    const isNewCourse = await registerCourse(courseId, courseName);
    if (isNewCourse) chrome.runtime.sendMessage({ type: 'course-registered' }).catch(() => {});
  }

  const scraped = toolType === 'worktodo' ? scrapeWorkToDo() : scrapeTable(toolType);
  if (DEBUG) console.log('[LEARN Deadline Tracker] scraped', toolType, scraped.length, 'items', scraped);
  if (scraped.length === 0) return;

  await mergeScrapedDeadlines(scraped, [`${courseId}:${toolType}`]);
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
