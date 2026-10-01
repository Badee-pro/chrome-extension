// Shared helpers used by both content.js (DOM-based scraping of the page
// you're currently viewing) and background.js (regex-based scraping of
// pages fetched in the background via the user's session cookies).

const DEBUG = true;

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

function monthIndex(name) {
  const short = name.toLowerCase().slice(0, 3);
  return MONTH_NAMES.findIndex((m) => m.toLowerCase().startsWith(short));
}

function classify(title, toolType) {
  if (toolType === 'quiz') return 'quiz';
  if (toolType === 'dropbox') return 'assignment';
  if (/\bquiz\b|\btest\b|\bexam\b/i.test(title)) return 'quiz';
  if (/\bassignment\b|\bdropbox\b|\bhomework\b|\blab\b/i.test(title)) return 'assignment';
  return 'other';
}

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ');
}

const FULL_DATE_RE =
  /Due on\s+([A-Z][a-z]{2,8}\s+\d{1,2},\s*\d{4})\s+(\d{1,2}:\d{2}\s*[AP]M)/;

function parseFullDateFromText(text) {
  const m = text.match(FULL_DATE_RE);
  if (!m) return null;
  const d = new Date(`${m[1]} ${m[2]}`);
  return isNaN(d.getTime()) ? null : d;
}

// Raw-HTML version of content-odyssey.js's DOM scraper, for use by the
// background service worker (no DOMParser available there). Odyssey's
// Assessment Schedule table is a single global page covering every course,
// so this is cheap to refresh automatically on every sync cycle.
function extractOdysseyItemsFromHtml(html, pageUrl) {
  const results = [];
  const rows = html.split(/<tr[\s>]/i).slice(1);

  for (const rowChunk of rows) {
    const cells = [...rowChunk.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)];
    if (cells.length < 3) continue;

    const examText = decodeEntities(cells[0][1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    const whenText = decodeEntities(cells[2][1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    if (!examText || !whenText) continue;

    const codeMatch = examText.match(/^([A-Z]{2,6}\s?\d{2,4}[A-Z]?)\s+(.+)$/);
    if (!codeMatch) continue;
    const code = codeMatch[1].trim();
    const title = codeMatch[2].trim();

    const whenMatch = whenText.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
    if (!whenMatch) continue;
    const [, y, mo, d, h, mi] = whenMatch;
    const due = new Date(
      parseInt(y, 10),
      parseInt(mo, 10) - 1,
      parseInt(d, 10),
      parseInt(h, 10),
      parseInt(mi, 10)
    );
    if (isNaN(due.getTime())) continue;

    results.push({
      id: `${code}:odyssey:${title}:${due.toISOString()}`,
      title,
      type: /quiz|test|midterm|final|exam/i.test(title) ? 'quiz' : 'assignment',
      due: due.toISOString(),
      courseId: code,
      courseName: code,
      url: pageUrl,
      source: 'scrape',
      scrapeKey: `${code}:odyssey`
    });
  }

  const byId = new Map();
  results.forEach((r) => byId.set(r.id, r));
  return Array.from(byId.values());
}

// Used by the background service worker, which has no DOMParser available.
// Finds `<a href="...">Title</a>` tags and looks for a "Due on <date>"
// within the following ~600 characters of raw markup (mirrors the row
// boundary content.js uses on the live DOM).
function extractItemsFromHtml(html, toolType, courseId, courseName, baseUrl) {
  const results = [];
  // Split into per-row chunks so a title link and its "Due on ..." text are
  // paired by table row, not by a fixed character distance (the real
  // markup between them varies a lot more than a fixed window allows for).
  const rows = html.split(/<tr[\s>]/i).slice(1);

  for (const rowChunk of rows) {
    const due = parseFullDateFromText(rowChunk);
    if (!due) continue;

    const linkMatch = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/.exec(rowChunk);
    if (!linkMatch) continue;

    const title = decodeEntities(linkMatch[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    if (!title) continue;

    let url;
    try {
      url = new URL(decodeEntities(linkMatch[1]), baseUrl).href;
    } catch {
      url = baseUrl;
    }

    results.push({
      id: `${courseId}:${toolType}:${title}:${due.toISOString()}`,
      title,
      type: classify(title, toolType),
      due: due.toISOString(),
      courseId,
      courseName,
      url,
      source: 'scrape',
      scrapeKey: `${courseId}:${toolType}`
    });
  }

  const byId = new Map();
  results.forEach((r) => byId.set(r.id, r));
  return Array.from(byId.values());
}

// Content scripts must NOT write to chrome.storage.local for deadlines or
// courses directly — the background service worker owns those writes
// through a serialized queue, so a content script's write can't be lost to
// a race with the background's own periodic sync. These just ask it to.
function requestMergeDeadlines(scraped, scrapeKeys) {
  return chrome.runtime.sendMessage({ type: 'merge-deadlines', scraped, scrapeKeys });
}

function requestRegisterCourse(id, name) {
  return chrome.runtime.sendMessage({ type: 'register-course', id, name });
}

async function registerCourse(id, name) {
  if (!id || !name) return false;
  const { courses = {} } = await chrome.storage.local.get('courses');
  if (courses[id] !== name) {
    courses[id] = name;
    await chrome.storage.local.set({ courses });
    return true;
  }
  return false;
}

async function mergeScrapedDeadlines(scraped, scrapeKeys) {
  const keys = new Set(
    scrapeKeys && scrapeKeys.length ? scrapeKeys : scraped.map((s) => s.scrapeKey)
  );
  const { deadlines = [] } = await chrome.storage.local.get('deadlines');
  const kept = deadlines.filter((d) => d.source === 'manual' || !keys.has(d.scrapeKey));
  const merged = [...kept, ...scraped];
  await chrome.storage.local.set({ deadlines: merged, lastScrapeAt: new Date().toISOString() });
}
