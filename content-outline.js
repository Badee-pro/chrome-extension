// Scrapes approximate event dates from a course's outline.uwaterloo.ca page.
// Unlike LEARN's Dropbox/Quiz pages, the "Tentative Class Plan" table only
// gives a week range (e.g. "Sept 16 - 21") for recurring quizzes, not an
// exact day — so these are stored as approximate, clearly labeled, and kept
// in their own scrapeKey so they never overwrite a precise LEARN date.

function parseTermYear(text) {
  const m = text.match(/\b(Fall|Winter|Spring)\s+(\d{4})\b/);
  if (!m) return { year: new Date().getFullYear(), startMonth: 0 };
  const termStartMonth = { Fall: 8, Winter: 0, Spring: 4 };
  return { year: parseInt(m[2], 10), startMonth: termStartMonth[m[1]] };
}

function getCourseInfo(text) {
  const codeMatch = text.match(/\b([A-Z]{2,6})\s?(\d{2,4}[A-Z]?)\b/);
  const code = codeMatch ? `${codeMatch[1]} ${codeMatch[2]}` : null;
  const termMatch = text.match(/\b(Fall|Winter|Spring)\s+(\d{4})\b/);
  const courseName = code && termMatch ? `${code} - ${termMatch[1]} ${termMatch[2]}` : code;
  return { code, courseName };
}

// Date ranges on this page use an en dash (–), not a plain hyphen.
const RANGE_RE = /([A-Z][a-z]{2,8})\s+(\d{1,2})\s*[-‐-―]\s*(?:[A-Z][a-z]{2,8}\s+)?(\d{1,2})/g;
const EVENT_RE = /\b(Quiz\s*\d+|Midterm(?:\s+Exam)?|Final\s+Exam|Assignment\s*\d*|Test\s*\d*)\b/i;

// Some outlines (e.g. MATH 239) state assignment due dates directly —
// "A1 due Sep 23" — instead of only giving a week range. This is an exact
// day (unlike the week-range quizzes below) and isn't covered by Odyssey
// (which only schedules quizzes/midterms, not take-home assignments), so
// it's kept in its own scrapeKey.
const ASSIGNMENT_DUE_RE = /\b(A\d{1,2}|Assignment\s*\d{1,2})\s+due\s+([A-Z][a-z]{2,8})\.?\s+(\d{1,2})\b/gi;

function scrapeAssignmentDueDates(text, code, courseName, year, startMonth) {
  const results = [];
  let m;
  while ((m = ASSIGNMENT_DUE_RE.exec(text)) !== null) {
    const mIdx = monthIndex(m[2]);
    if (mIdx === -1) continue;
    const eventYear = mIdx < startMonth ? year + 1 : year;
    const due = new Date(eventYear, mIdx, parseInt(m[3], 10), 23, 59, 0);
    if (isNaN(due.getTime())) continue;

    const num = m[1].match(/\d+/)[0];
    const title = `Assignment ${num}`;
    results.push({
      id: `${code}:outline-assignment:${title}:${due.toISOString()}`,
      title: `${title} (outline)`,
      type: 'assignment',
      due: due.toISOString(),
      courseId: code,
      courseName,
      url: location.href,
      source: 'scrape',
      scrapeKey: `${code}:outline-assignment`
    });
  }
  return results;
}

function scrapeOutline() {
  const text = document.body.innerText;
  const { code, courseName } = getCourseInfo(text);
  if (!code) return [];

  const planIdx = text.indexOf('Tentative Class Plan');
  if (planIdx === -1) return [];
  const endIdx = text.indexOf('Required Materials', planIdx);
  const planText = text.slice(planIdx, endIdx === -1 ? planIdx + 6000 : endIdx);

  const { year, startMonth } = parseTermYear(text);

  const ranges = [];
  let m;
  while ((m = RANGE_RE.exec(planText)) !== null) {
    ranges.push({ index: m.index, endIndex: RANGE_RE.lastIndex, month: m[1], day: parseInt(m[2], 10) });
  }

  const results = [];
  for (let i = 0; i < ranges.length; i++) {
    const chunkStart = ranges[i].endIndex;
    const chunkEnd = i + 1 < ranges.length ? ranges[i + 1].index : planText.length;
    const eventMatch = planText.slice(chunkStart, chunkEnd).match(EVENT_RE);
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
      url: location.href,
      source: 'scrape',
      scrapeKey: `${code}:outline`
    });
  }

  results.push(...scrapeAssignmentDueDates(text, code, courseName, year, startMonth));

  const byId = new Map();
  results.forEach((r) => byId.set(r.id, r));
  return Array.from(byId.values());
}

async function sync() {
  const scraped = scrapeOutline();
  if (DEBUG) console.log('[LEARN Deadline Tracker] outline scraped', scraped.length, scraped);
  if (scraped.length === 0) return;
  const scrapeKeys = [...new Set(scraped.map((s) => s.scrapeKey))];
  await requestMergeDeadlines(scraped, scrapeKeys).catch(() => {});
}

let attempts = 0;
const interval = setInterval(() => {
  attempts += 1;
  sync();
  if (attempts >= 4) clearInterval(interval);
}, 1500);
