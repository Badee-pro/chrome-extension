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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'deadlines-updated') {
    updateBadge();
  }
  if (msg && msg.type === 'course-registered') {
    syncAllCourses().then(updateBadge);
  }
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
    await mergeScrapedDeadlines(items, [`${courseId}:${toolType}`]);
  } catch (e) {
    if (DEBUG) console.log('[LEARN Deadline Tracker] bg sync error', toolType, courseId, e.message);
  }
}

async function discoverCourses() {
  try {
    const res = await fetch(`${BASE}/d2l/home`, { credentials: 'include' });
    if (!res.ok) {
      if (DEBUG) console.log('[LEARN Deadline Tracker] home fetch failed', res.status);
      return;
    }
    const html = await res.text();
    const discovered = discoverCoursesFromHtml(html);
    if (DEBUG) console.log('[LEARN Deadline Tracker] discovered courses', discovered);
    for (const c of discovered) {
      await registerCourse(c.id, c.name);
    }
  } catch (e) {
    if (DEBUG) console.log('[LEARN Deadline Tracker] discovery error', e.message);
  }
}

async function syncAllCourses() {
  await discoverCourses();
  const { courses = {} } = await chrome.storage.local.get('courses');
  for (const [id, name] of Object.entries(courses)) {
    await syncCoursePage(id, name, 'dropbox', `${BASE}/d2l/lms/dropbox/user/folders_list.d2l?ou=${id}`);
    await syncCoursePage(id, name, 'quiz', `${BASE}/d2l/lms/quizzing/user/quizzes_list.d2l?ou=${id}`);
  }
}
