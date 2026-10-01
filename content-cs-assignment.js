// Scrapes the precise "Due Date:" shown on an individual CS course content
// page (apps.online.cs.uwaterloo.ca — the Open edX "Learning" micro-frontend
// used for assignment/lab instructions). This is more granular than the
// Progress page's per-module due date, but only captures whichever page you
// actually visit — this is a single-page app, so a content script can't
// follow in-app navigation between assignments without a real page reload.

function getCourseCode() {
  const m = location.pathname.match(/course-v1:UW\+([A-Z0-9]+)\+/);
  return m ? m[1] : null;
}

function getTermYear() {
  const m = location.pathname.match(/\+(\d{4})_\d{2}/);
  return m ? parseInt(m[1], 10) : new Date().getFullYear();
}

// Matches both "Due Date: Friday, Oct. 2, 2026 at 3:00 pm" (table style)
// and "Lab Due Date: Friday, October 2, 5:00pm" (inline, no year).
const DUE_DATE_RE =
  /Due Date:\s*[A-Za-z]+,?\s+([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s*(\d{4})?,?\s*(?:at\s+)?(\d{1,2}):(\d{2})\s*(am|pm)/i;

function getPageTitle() {
  const h = document.querySelector('h1, h2');
  if (h && h.textContent.trim()) return h.textContent.trim();
  return document.title.split('|')[0].trim();
}

function scrapeAssignmentPage() {
  const code = getCourseCode();
  if (!code) return [];

  const text = document.body.innerText;
  const m = text.match(DUE_DATE_RE);
  if (!m) return [];

  const [, monthStr, day, yearStr, hourStr, minute, meridiem] = m;
  const mIdx = monthIndex(monthStr);
  if (mIdx === -1) return [];

  let hour = parseInt(hourStr, 10);
  if (/pm/i.test(meridiem) && hour !== 12) hour += 12;
  if (/am/i.test(meridiem) && hour === 12) hour = 0;

  const year = yearStr ? parseInt(yearStr, 10) : getTermYear();
  const due = new Date(year, mIdx, parseInt(day, 10), hour, parseInt(minute, 10));
  if (isNaN(due.getTime())) return [];

  const title = getPageTitle();
  if (!title) return [];

  // Keyed per-title so visiting one assignment's page never wipes out a
  // previously-scraped different assignment from this same course.
  return [
    {
      id: `${code}:cs-page:${title}:${due.toISOString()}`,
      title,
      type: 'assignment',
      due: due.toISOString(),
      courseId: code,
      courseName: code,
      url: location.href,
      source: 'scrape',
      scrapeKey: `${code}:cs-page:${title}`
    }
  ];
}

async function sync() {
  const scraped = scrapeAssignmentPage();
  if (DEBUG) console.log('[LEARN Deadline Tracker] cs-page scraped', scraped.length, scraped);
  if (scraped.length === 0) return;
  await requestMergeDeadlines(scraped, [scraped[0].scrapeKey]).catch(() => {});
}

let attempts = 0;
const interval = setInterval(() => {
  attempts += 1;
  sync();
  if (attempts >= 4) clearInterval(interval);
}, 1500);
