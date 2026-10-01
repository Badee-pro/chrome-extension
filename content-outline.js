// Scrapes approximate event dates from the outline.uwaterloo.ca page
// currently open in the tab. The actual extraction logic lives in
// common.js (extractOutlineItemsFromText) so the background service worker
// can reuse it against fetched HTML too.

async function sync() {
  const text = document.body.innerText;
  const { code, courseName } = extractCourseInfoFromText(text);
  if (!code) return;

  const scraped = extractOutlineItemsFromText(text, code, courseName, location.href);
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
