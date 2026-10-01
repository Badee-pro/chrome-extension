// Scrapes exact quiz/midterm dates and times from Odyssey's Assessment
// Schedule page. This is far more reliable than the outline page's week
// ranges since it's a clean, structured table with exact "YYYY-MM-DD
// HH:MM" timestamps (the actual scheduled exam time), not an estimate.

function parseCourseAndTitle(examText) {
  const m = examText.match(/^([A-Z]{2,6}\s?\d{2,4}[A-Z]?)\s+(.+)$/);
  if (!m) return { code: null, title: examText.trim() };
  return { code: m[1].trim(), title: m[2].trim() };
}

function parseWhen(whenText) {
  const m = whenText.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  const date = new Date(
    parseInt(y, 10),
    parseInt(mo, 10) - 1,
    parseInt(d, 10),
    parseInt(h, 10),
    parseInt(mi, 10)
  );
  return isNaN(date.getTime()) ? null : date;
}

function scrapeOdyssey() {
  const rows = document.querySelectorAll('table tr');
  const results = [];

  rows.forEach((row) => {
    const cells = row.querySelectorAll('td');
    if (cells.length < 3) return;

    const examText = cells[0].textContent.trim();
    const whenText = cells[2].textContent.trim();
    if (!examText || !whenText) return;

    const { code, title } = parseCourseAndTitle(examText);
    if (!code) return;

    const due = parseWhen(whenText);
    if (!due) return;

    results.push({
      id: `${code}:odyssey:${title}:${due.toISOString()}`,
      title,
      type: /quiz|test|midterm|final|exam/i.test(title) ? 'quiz' : 'assignment',
      due: due.toISOString(),
      courseId: code,
      courseName: code,
      url: location.href,
      source: 'scrape',
      scrapeKey: `${code}:odyssey`
    });
  });

  const byId = new Map();
  results.forEach((r) => byId.set(r.id, r));
  return Array.from(byId.values());
}

async function sync() {
  const scraped = scrapeOdyssey();
  if (DEBUG) console.log('[LEARN Deadline Tracker] odyssey scraped', scraped.length, scraped);
  if (scraped.length === 0) return;

  const scrapeKeys = [...new Set(scraped.map((s) => s.scrapeKey))];
  await mergeScrapedDeadlines(scraped, scrapeKeys);
  chrome.runtime.sendMessage({ type: 'deadlines-updated' }).catch(() => {});
}

let attempts = 0;
const interval = setInterval(() => {
  attempts += 1;
  sync();
  if (attempts >= 4) clearInterval(interval);
}, 1500);
