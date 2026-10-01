// On the Outline "Browse Outlines" listing page, discovers every enrolled
// course via its same-origin search API (which works fine from here, unlike
// a background fetch to the same endpoint — this page's own session context
// satisfies whatever check rejects the background worker's plain fetch) and
// asks the background script to open a hidden tab for each one. On an
// individual course's outline page, scrapes it as usual — the extraction
// logic lives in common.js (extractOutlineItemsFromText) so the hidden-tab
// flow and a manual visit both produce the same result.

async function runDiscovery() {
  try {
    const res = await fetch('/viewer/search/?q=', { credentials: 'same-origin' });
    if (!res.ok) {
      if (DEBUG) console.log('[LEARN Deadline Tracker] outline discovery fetch failed', res.status);
      return;
    }
    const list = await res.json();
    if (!Array.isArray(list) || list.length === 0) return;

    const currentTerm = list.reduce((max, c) => (c.term > max ? c.term : max), list[0].term);
    const current = list.filter((c) => c.term === currentTerm);
    if (DEBUG) console.log('[LEARN Deadline Tracker] outline discovered', current.map((c) => c.courses));

    chrome.runtime
      .sendMessage({
        type: 'open-hidden-tabs',
        urls: current.map((c) => `https://outline.uwaterloo.ca${c.url}`)
      })
      .catch(() => {});
  } catch (e) {
    if (DEBUG) console.log('[LEARN Deadline Tracker] outline discovery error', e.message);
  }
}

async function runScrape() {
  const text = document.body.innerText;
  const { code, courseName } = extractCourseInfoFromText(text);
  if (!code) return;

  const scraped = extractOutlineItemsFromText(text, code, courseName, location.href);
  if (DEBUG) console.log('[LEARN Deadline Tracker] outline scraped', scraped.length, scraped);
  if (scraped.length === 0) return;

  const scrapeKeys = [...new Set(scraped.map((s) => s.scrapeKey))];
  await requestMergeDeadlines(scraped, scrapeKeys).catch(() => {});
}

const isListingPage = location.pathname === '/viewer/' || location.pathname === '/viewer';

if (isListingPage) {
  // A plain API fetch doesn't need to wait for anything to render, so this
  // runs once — unlike the retry loop below, which exists because the
  // course page's content can take a moment to finish rendering.
  runDiscovery();
} else {
  let attempts = 0;
  const interval = setInterval(() => {
    attempts += 1;
    runScrape();
    if (attempts >= 4) clearInterval(interval);
  }, 1500);
}
