// Record store with two interchangeable backends:
//   - Postgres (when DATABASE_URL is set) — for production (Render + Neon)
//   - JSON file (otherwise)               — zero-config local dev
//
// Records are cached in memory, so reads stay synchronous. Mutations are
// async because they write through to the backend.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {Map<string, object>} */
let records = new Map();

// --- Backend selection ---------------------------------------------------
let backend;

function fileBackend() {
  const DATA_FILE = path.join(__dirname, '..', 'data', 'records.json');
  return {
    async init() {
      try {
        return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      } catch {
        return [];
      }
    },
    // File backend rewrites the whole file (simple; fine at this scale).
    async put() {
      fs.writeFileSync(DATA_FILE, JSON.stringify([...records.values()], null, 2));
    },
    async remove() {
      fs.writeFileSync(DATA_FILE, JSON.stringify([...records.values()], null, 2));
    },
  };
}

function pgBackend(databaseUrl) {
  // Imported lazily so local dev doesn't need the `pg` dependency installed.
  return import('pg').then(({ default: pg }) => {
    const needsSSL = !/localhost|127\.0\.0\.1/.test(databaseUrl);
    const pool = new pg.Pool({
      connectionString: databaseUrl,
      ssl: needsSSL ? { rejectUnauthorized: false } : false,
    });
    return {
      async init() {
        await pool.query(
          'CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, data JSONB NOT NULL)'
        );
        const { rows } = await pool.query('SELECT data FROM records');
        return rows.map((r) => r.data);
      },
      async put(rec) {
        await pool.query(
          `INSERT INTO records (id, data) VALUES ($1, $2)
           ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
          [rec.id, rec]
        );
      },
      async remove(id) {
        await pool.query('DELETE FROM records WHERE id = $1', [id]);
      },
    };
  });
}

export async function init() {
  backend = process.env.DATABASE_URL
    ? await pgBackend(process.env.DATABASE_URL)
    : fileBackend();
  const arr = await backend.init();
  records = new Map(arr.map((r) => [r.id, r]));
  console.log(
    `[store] using ${process.env.DATABASE_URL ? 'Postgres' : 'JSON file'} — ${records.size} record(s) loaded`
  );
}

const save = (rec) => backend.put(rec);

// --- Reads (sync, from cache) -------------------------------------------
export function getRecord(id) {
  return records.get(id) || null;
}

export function allRecords() {
  return [...records.values()];
}

// --- Mutations (async, write-through) -----------------------------------
/**
 * Create or update a subscription record. If `id` matches an existing record
 * it is updated; otherwise (or if missing) a new record is created.
 */
export async function upsertSubscription({ id, subscription, intervalMs }) {
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
  await save(rec);
  return rec;
}

export async function setInterval_(id, intervalMs) {
  const rec = records.get(id);
  if (!rec) return null;
  rec.intervalMs = intervalMs;
  // If a timer is already running, re-base it to the new interval from now.
  if (rec.running) rec.nextFireAt = Date.now() + intervalMs;
  await save(rec);
  return rec;
}

export async function startTimer(id) {
  const rec = records.get(id);
  if (!rec) return null;
  rec.running = true;
  rec.nextFireAt = Date.now() + rec.intervalMs;
  await save(rec);
  return rec;
}

export async function stopTimer(id) {
  const rec = records.get(id);
  if (!rec) return null;
  rec.running = false;
  rec.nextFireAt = null;
  await save(rec);
  return rec;
}

/**
 * Mark a key time as fired: log it in history and STOP the timer.
 * The next timer only restarts when the user opens the notification and
 * calls startTimer again.
 */
export async function recordFire(id, firedAt = Date.now()) {
  const rec = records.get(id);
  if (!rec) return null;
  rec.history.push({ firedAt });
  rec.running = false;
  rec.nextFireAt = null;
  await save(rec);
  return rec;
}

/** End the session: clear history and stop the timer. Keeps interval + subscription. */
export async function clearSession(id) {
  const rec = records.get(id);
  if (!rec) return null;
  rec.history = [];
  rec.running = false;
  rec.nextFireAt = null;
  await save(rec);
  return rec;
}

export async function removeRecord(id) {
  const ok = records.delete(id);
  if (ok) await backend.remove(id);
  return ok;
}
