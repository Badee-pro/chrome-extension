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

// Crude HTML-to-text conversion for the background service worker, which
// has no DOMParser. Not as faithful as a real innerText, but preserves
// enough line structure for the outline regexes below to still work.
function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<(br|\/tr|\/td|\/div|\/p|\/li|\/h[1-6])[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  );
}

function parseTermYear(text) {
  const m = text.match(/\b(Fall|Winter|Spring)\s+(\d{4})\b/);
  if (!m) return { year: new Date().getFullYear(), startMonth: 0 };
  const termStartMonth = { Fall: 8, Winter: 0, Spring: 4 };
  return { year: parseInt(m[2], 10), startMonth: termStartMonth[m[1]] };
}

function extractCourseInfoFromText(text) {
  const codeMatch = text.match(/\b([A-Z]{2,6})\s?(\d{2,4}[A-Z]?)\b/);
  const code = codeMatch ? `${codeMatch[1]} ${codeMatch[2]}` : null;
  const termMatch = text.match(/\b(Fall|Winter|Spring)\s+(\d{4})\b/);
  const courseName = code && termMatch ? `${code} - ${termMatch[1]} ${termMatch[2]}` : code;
  return { code, courseName };
}

// Date ranges on the outline page use an en dash (–), not a plain hyphen.
const OUTLINE_RANGE_RE = /([A-Z][a-z]{2,8})\s+(\d{1,2})\s*[-‐-―]\s*(?:[A-Z][a-z]{2,8}\s+)?(\d{1,2})/g;
const OUTLINE_EVENT_RE = /\b(Quiz\s*\d+|Midterm(?:\s+Exam)?|Final\s+Exam|Assignment\s*\d*|Test\s*\d*)\b/i;

// Some outlines (e.g. MATH 239) state assignment due dates directly —
// "A1 due Sep 23" — instead of only giving a week range. This is an exact
// day (unlike the week-range quizzes below) and isn't covered by Odyssey
// (which only schedules quizzes/midterms, not take-home assignments), so
// it's kept in its own scrapeKey.
const OUTLINE_ASSIGNMENT_DUE_RE = /\b(A\d{1,2}|Assignment\s*\d{1,2})\s+due\s+([A-Z][a-z]{2,8})\.?\s+(\d{1,2})\b/gi;

function extractOutlineItemsFromText(text, code, courseName, pageUrl) {
  const { year, startMonth } = parseTermYear(text);
  const results = [];

  const planIdx = text.indexOf('Tentative Class Plan');
  if (planIdx !== -1) {
    const endIdx = text.indexOf('Required Materials', planIdx);
    const planText = text.slice(planIdx, endIdx === -1 ? planIdx + 6000 : endIdx);

    const ranges = [];
    let m;
    OUTLINE_RANGE_RE.lastIndex = 0;
    while ((m = OUTLINE_RANGE_RE.exec(planText)) !== null) {
      ranges.push({ index: m.index, endIndex: OUTLINE_RANGE_RE.lastIndex, month: m[1], day: parseInt(m[2], 10) });
    }

    for (let i = 0; i < ranges.length; i++) {
      const chunkStart = ranges[i].endIndex;
      const chunkEnd = i + 1 < ranges.length ? ranges[i + 1].index : planText.length;
      const eventMatch = planText.slice(chunkStart, chunkEnd).match(OUTLINE_EVENT_RE);
      if (!eventMatch) continue;

      const mIdx = monthIndex(ranges[i].month);
      if (mIdx === -1) continue;
      const eventYear = mIdx < startMonth ? year + 1 : year;
      const due = new Date(eventYear, mIdx, ranges[i].day, 12, 0, 0);
      if (isNaN(due.getTime())) continue;

      const eventTitle = eventMatch[1].replace(/\s+/g, ' ').trim();
      results.push({
        id: `${code}:outline:${eventTitle}:${due.toISOString()}`,
        title: `${eventTitle} (approx, outline)`,
        type: /quiz|test|midterm|final/i.test(eventTitle) ? 'quiz' : 'assignment',
        due: due.toISOString(),
        courseId: code,
        courseName,
        url: pageUrl,
        source: 'scrape',
        scrapeKey: `${code}:outline`
      });
    }
  }

  OUTLINE_ASSIGNMENT_DUE_RE.lastIndex = 0;
  let am;
  while ((am = OUTLINE_ASSIGNMENT_DUE_RE.exec(text)) !== null) {
    const mIdx = monthIndex(am[2]);
    if (mIdx === -1) continue;
    const eventYear = mIdx < startMonth ? year + 1 : year;
    const due = new Date(eventYear, mIdx, parseInt(am[3], 10), 23, 59, 0);
    if (isNaN(due.getTime())) continue;

    const num = am[1].match(/\d+/)[0];
    const title = `Assignment ${num}`;
    results.push({
      id: `${code}:outline-assignment:${title}:${due.toISOString()}`,
      title: `${title} (outline)`,
      type: 'assignment',
      due: due.toISOString(),
      courseId: code,
      courseName,
      url: pageUrl,
      source: 'scrape',
      scrapeKey: `${code}:outline-assignment`
    });
  }

  const byId = new Map();
  results.forEach((r) => byId.set(r.id, r));
  return Array.from(byId.values());
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
