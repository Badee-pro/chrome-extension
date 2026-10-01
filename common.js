// Shared helpers used by both content.js (DOM-based scraping of the page
// you're currently viewing) and background.js (regex-based scraping of
// pages fetched in the background via the user's session cookies).

const DEBUG = true;

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

// Used by the background service worker, which has no DOMParser available.
// Finds `<a href="...">Title</a>` tags and looks for a "Due on <date>"
// within the following ~600 characters of raw markup (mirrors the row
// boundary content.js uses on the live DOM).
function extractItemsFromHtml(html, toolType, courseId, courseName, baseUrl) {
  const results = [];
  const linkRe = /<a\s+[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let match;
  while ((match = linkRe.exec(html)) !== null) {
    const titleRaw = match[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const title = decodeEntities(titleRaw);
    if (!title) continue;

    const windowText = html.slice(match.index, match.index + 600);
    const due = parseFullDateFromText(windowText);
    if (!due) continue;

    let url;
    try {
      url = new URL(decodeEntities(match[1]), baseUrl).href;
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

async function registerCourse(id, name) {
  if (!id || !name) return;
  const { courses = {} } = await chrome.storage.local.get('courses');
  if (courses[id] !== name) {
    courses[id] = name;
    await chrome.storage.local.set({ courses });
  }
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
