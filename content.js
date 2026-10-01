// Scrapes the Brightspace Calendar (agenda/list view) for assignment & quiz
// deadlines. Brightspace renders this UI with web components, some of which
// use shadow DOM, so plain querySelectorAll on `document` misses content.
// This walks shadow roots too. If Waterloo changes their Calendar layout,
// tune KEYWORDS / DATE_RE / the link-href filter below and reload the page.

const DEBUG = true;

const KEYWORDS = {
  quiz: /\bquiz\b|\btest\b|\bexam\b/i,
  assignment: /\bassignment\b|\bdropbox\b|\bhomework\b|\blab\b|\bpaper\b|\bessay\b/i
};

const LINK_HINT_RE = /\/d2l\/(lms\/dropbox|lms\/quizzing|le\/content)\//i;

const DATE_RE =
  /\b([A-Z][a-z]{2,8})\s+(\d{1,2}),\s*(\d{4})(?:\s*(?:at)?\s*(\d{1,2}):(\d{2})\s*(AM|PM))?\b/;

function collectAllElements(root, out) {
  const walker = root.querySelectorAll ? root.querySelectorAll('*') : [];
  walker.forEach((el) => {
    out.push(el);
    if (el.shadowRoot) collectAllElements(el.shadowRoot, out);
  });
  return out;
}

function parseDate(text) {
  const m = text.match(DATE_RE);
  if (!m) return null;
  const [, month, day, year, hour, minute, ampm] = m;
  let h = hour ? parseInt(hour, 10) : 23;
  const min = minute ? parseInt(minute, 10) : 59;
  if (ampm) {
    if (/PM/i.test(ampm) && h !== 12) h += 12;
    if (/AM/i.test(ampm) && h === 12) h = 0;
  }
  const d = new Date(`${month} ${day}, ${year} ${h}:${min}:00`);
  return isNaN(d.getTime()) ? null : d;
}

function classify(title) {
  if (KEYWORDS.quiz.test(title)) return 'quiz';
  if (KEYWORDS.assignment.test(title)) return 'assignment';
  return 'other';
}

function extractCourseCode(href) {
  const m = href && href.match(/ou=(\d+)/);
  return m ? m[1] : null;
}

function scrapeCalendar() {
  const all = collectAllElements(document, []);
  const links = all.filter(
    (el) => el.tagName === 'A' && el.href && LINK_HINT_RE.test(el.href)
  );

  const found = [];
  for (const link of links) {
    const title = (link.textContent || '').trim();
    if (!title) continue;

    // Search the link's ancestors (up a few levels) and their text for a
    // nearby date, since the date is usually a sibling label, not inside
    // the link itself.
    let dateText = '';
    let node = link;
    for (let i = 0; i < 6 && node; i++) {
      dateText += ' ' + (node.textContent || '');
      node = node.parentElement || (node.getRootNode && node.getRootNode().host);
    }

    const due = parseDate(dateText);
    if (!due) continue;

    found.push({
      id: link.href + '|' + due.toISOString(),
      title,
      type: classify(title),
      due: due.toISOString(),
      courseId: extractCourseCode(link.href),
      url: link.href,
      source: 'scrape'
    });
  }

  // De-dupe by id
  const byId = new Map();
  found.forEach((item) => byId.set(item.id, item));
  return Array.from(byId.values());
}

async function sync() {
  const scraped = scrapeCalendar();
  if (DEBUG) console.log('[LEARN Deadline Tracker] scraped', scraped.length, 'items', scraped);

  if (scraped.length === 0) return;

  const { deadlines = [] } = await chrome.storage.local.get('deadlines');
  const manual = deadlines.filter((d) => d.source === 'manual');
  const merged = [...manual, ...scraped];

  await chrome.storage.local.set({ deadlines: merged, lastScrapeAt: new Date().toISOString() });
  chrome.runtime.sendMessage({ type: 'deadlines-updated' }).catch(() => {});
}

// Brightspace loads the calendar content asynchronously after navigation,
// so retry a few times instead of scraping once at document_idle.
let attempts = 0;
const interval = setInterval(() => {
  attempts += 1;
  sync();
  if (attempts >= 6) clearInterval(interval);
}, 2000);
