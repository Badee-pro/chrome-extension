const CHECK_ALARM = 'deadline-check';
const NOTIFY_WINDOW_HOURS = 24;

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(CHECK_ALARM, { periodInMinutes: 30 });
  updateBadge();
});

chrome.runtime.onStartup.addListener(() => {
  updateBadge();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CHECK_ALARM) {
    checkAndNotify();
    updateBadge();
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'deadlines-updated') {
    updateBadge();
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

function upcoming(deadlines, days = 7) {
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
  const dueSoon = upcoming(deadlines, 2);
  const count = dueSoon.length;
  chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
  chrome.action.setBadgeBackgroundColor({ color: count > 0 ? '#d93025' : '#5f6368' });
}

async function checkAndNotify() {
  const deadlines = await getDeadlines();
  const { notified = {} } = await chrome.storage.local.get('notified');
  const now = Date.now();
  const nextNotified = { ...notified };

  for (const item of deadlines) {
    const dueTime = new Date(item.due).getTime();
    const hoursUntil = (dueTime - now) / (1000 * 60 * 60);
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
