// Tiny JSON-file store. One file holds all subscription/timer records.
// Keyed by a client-held `id`. Pure JS, no native deps — swap for Postgres later.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, '..', 'data', 'records.json');

/** @type {Map<string, object>} */
let records = new Map();

function load() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const arr = JSON.parse(raw);
    records = new Map(arr.map((r) => [r.id, r]));
  } catch {
    records = new Map();
  }
}

function persist() {
  const arr = [...records.values()];
  fs.writeFileSync(DATA_FILE, JSON.stringify(arr, null, 2));
}

load();

export function getRecord(id) {
  return records.get(id) || null;
}

export function allRecords() {
  return [...records.values()];
}

/**
 * Create or update a subscription record. If `id` matches an existing record
 * it is updated; otherwise (or if missing) a new record is created.
 */
export function upsertSubscription({ id, subscription, intervalMs }) {
  let rec = id ? records.get(id) : null;

  if (!rec) {
    // De-dupe by endpoint so re-subscribing the same browser reuses its record.
    rec = [...records.values()].find(
      (r) => r.subscription?.endpoint === subscription.endpoint
    );
  }

  if (rec) {
    rec.subscription = subscription;
    if (typeof intervalMs === 'number') rec.intervalMs = intervalMs;
  } else {
    rec = {
      id: crypto.randomUUID(),
      subscription,
      intervalMs: typeof intervalMs === 'number' ? intervalMs : 60 * 60 * 1000,
      nextFireAt: null,
      running: false,
      createdAt: Date.now(),
      history: [],
    };
    records.set(rec.id, rec);
  }
  persist();
  return rec;
}

export function setInterval_(id, intervalMs) {
  const rec = records.get(id);
  if (!rec) return null;
  rec.intervalMs = intervalMs;
  // If a timer is already running, re-base it to the new interval from now.
  if (rec.running) rec.nextFireAt = Date.now() + intervalMs;
  persist();
  return rec;
}

export function startTimer(id) {
  const rec = records.get(id);
  if (!rec) return null;
  rec.running = true;
  rec.nextFireAt = Date.now() + rec.intervalMs;
  persist();
  return rec;
}

export function stopTimer(id) {
  const rec = records.get(id);
  if (!rec) return null;
  rec.running = false;
  rec.nextFireAt = null;
  persist();
  return rec;
}

/**
 * Mark a key time as fired: log it in history and STOP the timer.
 * The next timer only restarts when the user opens the notification and
 * calls startTimer again.
 */
export function recordFire(id, firedAt = Date.now()) {
  const rec = records.get(id);
  if (!rec) return null;
  rec.history.push({ firedAt });
  rec.running = false;
  rec.nextFireAt = null;
  persist();
  return rec;
}

export function removeRecord(id) {
  const ok = records.delete(id);
  if (ok) persist();
  return ok;
}
