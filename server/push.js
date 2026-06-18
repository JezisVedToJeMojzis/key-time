// Web Push setup + the scheduler that fires "It's key time!" notifications.
import webpush from 'web-push';
import { allRecords, recordsByUser, recordFire, removeRecord } from './store.js';

const {
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY,
  VAPID_SUBJECT = 'mailto:you@example.com',
} = process.env;

export const vapidConfigured = Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);

if (vapidConfigured) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
} else {
  console.warn(
    '[push] VAPID keys missing — notifications are disabled. Run `npm run gen-vapid` and add them to .env.'
  );
}

export function getPublicKey() {
  return VAPID_PUBLIC_KEY || null;
}

const KEY_TIME_PAYLOAD = JSON.stringify({
  title: "It's key time! 🔑",
  body: 'Open to start the next timer.',
});

async function sendTo(rec, payload = KEY_TIME_PAYLOAD) {
  try {
    await webpush.sendNotification(rec.subscription, payload);
    return true;
  } catch (err) {
    // 404/410 mean the subscription is gone — clean it up.
    if (err.statusCode === 404 || err.statusCode === 410) {
      console.log(`[push] subscription expired, removing ${rec.id}`);
      await removeRecord(rec.id);
    } else {
      console.error(`[push] send failed for ${rec.id}:`, err.statusCode, err.body || err.message);
    }
    return false;
  }
}

/**
 * Send a notification to all of a user's devices.
 * `payload` is { title, body, data? } — `data.url` controls where a click lands.
 */
export async function pushToUser(userId, payload) {
  if (!vapidConfigured) return 0;
  const body = JSON.stringify(payload);
  let sent = 0;
  for (const rec of recordsByUser(userId)) {
    if (await sendTo(rec, body)) sent++;
  }
  return sent;
}

/**
 * Process all due timers: send the push and log the key-time event.
 * Returns the number of notifications sent.
 */
export async function tick(now = Date.now()) {
  if (!vapidConfigured) return 0;
  let sent = 0;
  for (const rec of allRecords()) {
    if (rec.running && rec.nextFireAt && rec.nextFireAt <= now) {
      // Record the fire first so a failed send still stops the timer
      // (avoids a tight retry loop). Then attempt delivery.
      await recordFire(rec.id, rec.nextFireAt);
      const ok = await sendTo(rec);
      if (ok) sent++;
    }
  }
  return sent;
}
