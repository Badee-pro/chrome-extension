importScripts('common.js');

const CHECK_ALARM = 'deadline-check';
const NOTIFY_WINDOW_HOURS = 24;
const BASE = 'https://learn.uwaterloo.ca';

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(CHECK_ALARM, { periodInMinutes: 20 });
  syncAllCourses().then(() => {
    checkAndNotify();
    updateBadge();
  });
});

chrome.runtime.onStartup.addListener(() => {
  syncAllCourses().then(() => {
    checkAndNotify();
    updateBadge();
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CHECK_ALARM) {
    syncAllCourses().then(() => {
      checkAndNotify();
      updateBadge();
    });
  }
});

// Content scripts (LEARN, Outline, Odyssey pages) and this background
// script's own periodic sync can both try to read-modify-write the same
// storage key at the same time. Routing every write through this single
// queue serializes them so a slow background sync can't silently clobber
// a content script's write that landed in between its read and write.
let writeQueue = Promise.resolve();
function enqueueWrite(fn) {
  const result = writeQueue.then(fn, fn);
  writeQueue = result.then(
    () => {},
    () => {}
  );
  return result;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'manual-sync') {
    syncAllCourses()
      .then(() => {
        checkAndNotify();
        updateBadge();
        sendResponse({ ok: true });
      })
      .catch(() => sendResponse({ ok: false }));
    return true; // keep the message channel open for the async response
  }

  if (msg && msg.type === 'merge-deadlines') {
    enqueueWrite(() => mergeScrapedDeadlines(msg.scraped, msg.scrapeKeys))
      .then(() => {
        updateBadge();
        sendResponse({ ok: true });
      })
      .catch((e) => {
        if (DEBUG) console.log('[LEARN Deadline Tracker] merge-deadlines failed', e && e.message);
        sendResponse({ ok: false, error: e && e.message });
      });
    return true;
  }

  if (msg && msg.type === 'register-course') {
    enqueueWrite(() => registerCourse(msg.id, msg.name))
      .then((isNew) => {
        sendResponse({ ok: true, isNew });
        if (isNew) syncAllCourses().then(updateBadge);
      })
      .catch((e) => {
        if (DEBUG) console.log('[LEARN Deadline Tracker] register-course failed', e && e.message);
        sendResponse({ ok: false, error: e && e.message });
      });
    return true;
  }

  if (msg && msg.type === 'open-hidden-tabs') {
    openHiddenTabsSequentially(msg.urls || []);
    // Fire-and-forget: each tab's own content script reports back via its
    // own 'merge-deadlines' message once it's scraped the page.
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.deadlines) {
    updateBadge();
  }
});

async function getDeadlines() {
  const { deadlines = [] } = await chrome.storage.local.get('deadlines');
  return deadlines;
}

function upcoming(deadlines, days) {
  const now = Date.now();
  const horizon = now + days * 24 * 60 * 60 * 1000;
  return deadlines
    .filter((d) => {
      const t = new Date(d.due).getTime();
      return t >= now - 60 * 60 * 1000 && t <= horizon;
    })
    .sort((a, b) => new Date(a.due) - new Date(b.due));
}

async function updateBadge() {
  const deadlines = await getDeadlines();
  const count = upcoming(deadlines, 2).length;
  chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
  chrome.action.setBadgeBackgroundColor({ color: count > 0 ? '#d93025' : '#5f6368' });
}

async function checkAndNotify() {
  const deadlines = await getDeadlines();
  const { notified = {} } = await chrome.storage.local.get('notified');
  const now = Date.now();
  const nextNotified = { ...notified };

  for (const item of deadlines) {
    const hoursUntil = (new Date(item.due).getTime() - now) / (1000 * 60 * 60);
    if (hoursUntil > 0 && hoursUntil <= NOTIFY_WINDOW_HOURS && !notified[item.id]) {
      chrome.notifications.create(item.id, {
        type: 'basic',
        iconUrl: 'icon128.png',
        title: `Due soon: ${item.title}`,
        message: `Due ${new Date(item.due).toLocaleString()}`,
        priority: 2
      });
      nextNotified[item.id] = true;
    }
  }

  await chrome.storage.local.set({ notified: nextNotified });
}

chrome.notifications.onClicked.addListener(async (notificationId) => {
  const deadlines = await getDeadlines();
  const item = deadlines.find((d) => d.id === notificationId);
  if (item && item.url) {
    chrome.tabs.create({ url: item.url });
  }
});

async function syncCoursePage(courseId, courseName, toolType, url) {
  try {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) {
      if (DEBUG) console.log('[LEARN Deadline Tracker] bg fetch failed', toolType, courseId, res.status);
      return;
    }
    const html = await res.text();
    const items = extractItemsFromHtml(html, toolType, courseId, courseName, BASE);
    if (DEBUG) console.log('[LEARN Deadline Tracker] bg-scraped', toolType, courseId, items.length);
    await enqueueWrite(() => mergeScrapedDeadlines(items, [`${courseId}:${toolType}`]));
  } catch (e) {
    if (DEBUG) console.log('[LEARN Deadline Tracker] bg sync error', toolType, courseId, e.message);
  }
}

// The LEARN homepage loads your enrolled courses via this API after the
// page renders, so the HTML itself never contains the course list — this
// calls the same endpoint directly instead of scraping a client-rendered
// page. Filters to currently-active courses so it stays correct across
// terms without hardcoding a semester id.
const MYCOURSES_URL =
  `${BASE}/d2l/le/manageCourses/api/mycourses?pageSize=50&sort=current&autoPinCourses=false&orgUnitTypeId=3&promotePins=true&embedDepth=0&widgetId=27968`;

async function discoverCourses() {
  try {
    const res = await fetch(MYCOURSES_URL, { credentials: 'include' });
    if (!res.ok) {
      if (DEBUG) console.log('[LEARN Deadline Tracker] mycourses fetch failed', res.status);
      return;
    }
    const data = await res.json();
    const active = (data.Courses || []).filter(
      (c) => c.IsActive && (!c.EndDate || new Date(c.EndDate).getTime() > Date.now())
    );
    if (DEBUG) console.log('[LEARN Deadline Tracker] discovered courses', active.map((c) => c.Name));
    for (const c of active) {
      await enqueueWrite(() => registerCourse(String(c.OrgUnitId), c.Name));
    }
  } catch (e) {
    if (DEBUG) console.log('[LEARN Deadline Tracker] discovery error', e.message);
  }
}

// Outline and Odyssey both reject a plain background fetch (outline returns
// its login page's HTML instead of JSON; odyssey fails outright) — their
// SSO session apparently requires a real page navigation that a service
// worker fetch can't replicate. Opening a real (hidden, non-focused) tab
// satisfies that, and the existing content scripts for those pages handle
// the actual scraping exactly as if visited manually — this just automates
// the "visiting" part.
function openHiddenTab(url, waitMs) {
  return new Promise((resolve) => {
    chrome.tabs.create({ url, active: false }, (tab) => {
      if (!tab || !tab.id) {
        resolve();
        return;
      }
      setTimeout(() => {
        chrome.tabs.remove(tab.id, () => resolve());
      }, waitMs);
    });
  });
}

async function openHiddenTabsSequentially(urls) {
  for (const url of urls) {
    await openHiddenTab(url, 8000);
  }
}

async function syncAllCourses() {
  await discoverCourses();
  const { courses = {} } = await chrome.storage.local.get('courses');
  for (const [id, name] of Object.entries(courses)) {
    await syncCoursePage(id, name, 'dropbox', `${BASE}/d2l/lms/dropbox/user/folders_list.d2l?ou=${id}`);
    await syncCoursePage(id, name, 'quiz', `${BASE}/d2l/lms/quizzing/user/quizzes_list.d2l?ou=${id}`);
  }
  // Odyssey is a single page covering every course, so just open it.
  // Outline needs its listing page first — that page's own content script
  // (content-outline.js) discovers enrolled courses and asks us to open a
  // hidden tab per course via the 'open-hidden-tabs' message handler.
  await openHiddenTab('https://odyssey.uwaterloo.ca/teaching/schedule', 8000);
  await openHiddenTab('https://outline.uwaterloo.ca/viewer/?q=', 5000);
}
