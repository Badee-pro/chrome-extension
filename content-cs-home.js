// Scrapes per-activity due dates (Lessons/Concept Checks, Lab, Reading,
// etc.) from a CS course's "home" page on the Open edX Learning MFE
// (apps.online.cs.uwaterloo.ca/learning/course/.../home). This is more
// granular than the Progress page's module-level aggregate date. Note:
// if a module's content only renders in the DOM once its accordion section
// is expanded, this will only catch whichever modules are already open
// when the page loads, not every module.

function getCourseCode() {
  const m = location.pathname.match(/course-v1:UW\+([A-Z0-9]+)\+/);
  return m ? m[1] : null;
}

const MODULE_RE = /Module\s+(\d+):\s*([^\n]+)/g;
const ACTIVITY_DUE_RE =
  /\b(Lessons?|Concept Checks?|Lab|Reading)s?\b[^.]{0,80}?\bdue\s+([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s*(\d{4})?,?\s*(\d{1,2}):(\d{2})\s*(AM|PM|am|pm)?/g;

function scrapeHome() {
  const code = getCourseCode();
  if (!code) return [];

  const text = document.body.textContent.replace(/\s+/g, ' ');
  const modules = [];
  let m;
  MODULE_RE.lastIndex = 0;
  while ((m = MODULE_RE.exec(text)) !== null) {
    modules.push({ index: m.index, endIndex: MODULE_RE.lastIndex, num: m[1], name: m[2].trim() });
  }

  const results = [];
  for (let i = 0; i < modules.length; i++) {
    const chunkStart = modules[i].endIndex;
    const chunkEnd = i + 1 < modules.length ? modules[i + 1].index : text.length;
    const chunk = text.slice(chunkStart, chunkEnd);

    ACTIVITY_DUE_RE.lastIndex = 0;
    let dm;
    while ((dm = ACTIVITY_DUE_RE.exec(chunk)) !== null) {
      const [, label, monthStr, day, yearStr, hourStr, minute, meridiem] = dm;
      const mIdx = monthIndex(monthStr);
      if (mIdx === -1) continue;

      let hour = parseInt(hourStr, 10);
      if (meridiem && /pm/i.test(meridiem) && hour !== 12) hour += 12;
      if (meridiem && /am/i.test(meridiem) && hour === 12) hour = 0;

      const year = yearStr ? parseInt(yearStr, 10) : new Date().getFullYear();
      const due = new Date(year, mIdx, parseInt(day, 10), hour, parseInt(minute, 10));
      if (isNaN(due.getTime())) continue;

      const title = `Module ${modules[i].num}: ${modules[i].name} - ${label.trim()}`;
      results.push({
        id: `${code}:cs-home:${title}:${due.toISOString()}`,
        title,
        type: 'assignment',
        due: due.toISOString(),
        courseId: code,
        courseName: code,
        url: location.href,
        source: 'scrape',
        scrapeKey: `${code}:cs-home`
      });
    }
  }

  const byId = new Map();
  results.forEach((r) => byId.set(r.id, r));
  return Array.from(byId.values());
}

async function sync() {
  const scraped = scrapeHome();
  if (DEBUG) console.log('[LEARN Deadline Tracker] cs-home scraped', scraped.length, scraped);
  if (scraped.length === 0) return;
  await requestMergeDeadlines(scraped, [scraped[0].scrapeKey]).catch(() => {});
}

let attempts = 0;
const interval = setInterval(() => {
  attempts += 1;
  sync();
  if (attempts >= 5) clearInterval(interval);
}, 1500);

// This script runs on every page of the course (not just home), so this
// discovery step cascades: the home page finds module/lab links, each of
// those pages finds its own sub-links (questions, next/prev), and so on.
// The background script dedupes by block id so this terminates once every
// reachable page has been visited once, instead of looping forever.
async function expandAllSections() {
  const toggles = Array.from(document.querySelectorAll('[aria-expanded="false"]'));
  for (const t of toggles) {
    try {
      t.click();
    } catch {
      // ignore elements that aren't actually clickable
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

function discoverBlockLinks() {
  const anchors = Array.from(document.querySelectorAll('a[href*="block-v1"]'));
  const urls = new Set();
  anchors.forEach((a) => {
    const href = a.getAttribute('href');
    if (!href) return;
    try {
      urls.add(new URL(href, location.href).href);
    } catch {
      // ignore malformed hrefs
    }
  });
  return Array.from(urls);
}

async function runDiscovery() {
  await expandAllSections();
  const urls = discoverBlockLinks();
  if (DEBUG) console.log('[LEARN Deadline Tracker] cs-home discovered links', urls.length);
  if (urls.length === 0) return;
  chrome.runtime.sendMessage({ type: 'crawl-discovered-links', urls }).catch(() => {});
}

setTimeout(runDiscovery, 3000);
