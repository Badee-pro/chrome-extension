// Scrapes exact module due dates from a UW CS course's Open edX "Progress"
// page (online.cs.uwaterloo.ca/courses/course-v1:UW+<CODE>+<term>/progress).
// Each module block gives a full "due <Month> <Day>, <Year> <H>:<MM> <TZ>"
// line, so unlike the outline page this needs no estimation.

function getCourseCode() {
  const m = location.pathname.match(/course-v1:UW\+([A-Z0-9]+)\+/);
  return m ? m[1] : null;
}

const MODULE_RE = /Module\s+(\d+):\s*([^\n]+)/g;
const DUE_RE = /due\s+([A-Z][a-z]{2,8})\s+(\d{1,2}),\s*(\d{4})\s+(\d{1,2}):(\d{2})/i;

function scrapeProgress() {
  const code = getCourseCode();
  if (!code) return [];

  const text = document.body.innerText;
  const modules = [];
  let m;
  while ((m = MODULE_RE.exec(text)) !== null) {
    modules.push({ index: m.index, endIndex: MODULE_RE.lastIndex, num: m[1], name: m[2].trim() });
  }

  const results = [];
  for (let i = 0; i < modules.length; i++) {
    const chunkStart = modules[i].endIndex;
    const chunkEnd = i + 1 < modules.length ? modules[i + 1].index : text.length;
    const dueMatch = text.slice(chunkStart, chunkEnd).match(DUE_RE);
    if (!dueMatch) continue;

    const [, monthStr, day, year, hour, minute] = dueMatch;
    const mIdx = monthIndex(monthStr);
    if (mIdx === -1) continue;

    const due = new Date(
      parseInt(year, 10),
      mIdx,
      parseInt(day, 10),
      parseInt(hour, 10),
      parseInt(minute, 10)
    );
    if (isNaN(due.getTime())) continue;

    const title = `Module ${modules[i].num}: ${modules[i].name}`;
    results.push({
      id: `${code}:progress:${title}:${due.toISOString()}`,
      title,
      type: 'assignment',
      due: due.toISOString(),
      courseId: code,
      courseName: code,
      url: location.href,
      source: 'scrape',
      scrapeKey: `${code}:progress`
    });
  }

  const byId = new Map();
  results.forEach((r) => byId.set(r.id, r));
  return Array.from(byId.values());
}

async function sync() {
  const scraped = scrapeProgress();
  if (DEBUG) console.log('[LEARN Deadline Tracker] progress scraped', scraped.length, scraped);
  if (scraped.length === 0) return;
  await requestMergeDeadlines(scraped, [scraped[0].scrapeKey]).catch(() => {});
}

let attempts = 0;
const interval = setInterval(() => {
  attempts += 1;
  sync();
  if (attempts >= 4) clearInterval(interval);
}, 1500);
