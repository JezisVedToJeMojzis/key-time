// Multi-collection store with two interchangeable backends:
//   - Postgres (when DATABASE_URL is set) — for production (Render + Neon)
//   - JSON file (otherwise)               — zero-config local dev
//
// Each collection is a table (Postgres) or a key in one JSON file. Items are
// cached in memory, so reads stay synchronous; mutations write through (async).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const COLLECTIONS = ['records', 'users', 'friendships', 'invites', 'sessions', 'groups'];

/** @type {Record<string, Map<string, object>>} */
const data = Object.fromEntries(COLLECTIONS.map((c) => [c, new Map()]));

// --- Backend selection ---------------------------------------------------
let backend;

function fileBackend() {
  const DATA_FILE = path.join(__dirname, '..', 'data', 'store.json');
  const writeAll = () => {
    const out = {};
    for (const c of COLLECTIONS) out[c] = [...data[c].values()];
    fs.writeFileSync(DATA_FILE, JSON.stringify(out, null, 2));
  };
  return {
    async init() {
      try {
        const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        const out = {};
        for (const c of COLLECTIONS) out[c] = raw[c] || [];
        return out;
      } catch {
        return Object.fromEntries(COLLECTIONS.map((c) => [c, []]));
      }
    },
    async put() {
      writeAll();
    },
    async remove() {
      writeAll();
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
        const out = {};
        for (const c of COLLECTIONS) {
          await pool.query(
            `CREATE TABLE IF NOT EXISTS ${c} (id TEXT PRIMARY KEY, data JSONB NOT NULL)`
          );
          const { rows } = await pool.query(`SELECT data FROM ${c}`);
          out[c] = rows.map((r) => r.data);
        }
        return out;
      },
      async put(collection, item) {
        await pool.query(
          `INSERT INTO ${collection} (id, data) VALUES ($1, $2)
           ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
          [item.id, item]
        );
      },
      async remove(collection, id) {
        await pool.query(`DELETE FROM ${collection} WHERE id = $1`, [id]);
      },
    };
  });
}

export async function init() {
  backend = process.env.DATABASE_URL
    ? await pgBackend(process.env.DATABASE_URL)
    : fileBackend();
  const loaded = await backend.init();
  for (const c of COLLECTIONS) {
    data[c] = new Map((loaded[c] || []).map((item) => [item.id, item]));
  }
  console.log(
    `[store] using ${process.env.DATABASE_URL ? 'Postgres' : 'JSON file'} — ` +
      COLLECTIONS.map((c) => `${data[c].size} ${c}`).join(', ')
  );
}

// Generic write-through helpers.
const save = (collection, item) => {
  data[collection].set(item.id, item);
  return backend.put(collection, item);
};
const drop = (collection, id) => {
  const ok = data[collection].delete(id);
  return ok ? backend.remove(collection, id).then(() => true) : Promise.resolve(false);
};

// =========================================================================
// Records (device timers + push subscriptions)
// =========================================================================
export function getRecord(id) {
  return data.records.get(id) || null;
}

export function allRecords() {
  return [...data.records.values()];
}

export function recordsByUser(userId) {
  return [...data.records.values()].filter((r) => r.userId === userId);
}

/**
 * Create or update a subscription record. Stamps the owning userId so the
 * server can later push to all of a user's devices.
 */
export async function upsertSubscription({ id, subscription, intervalMs, userId }) {
  let rec = id ? data.records.get(id) : null;

  if (!rec) {
    // De-dupe by endpoint so re-subscribing the same browser reuses its record.
    rec = [...data.records.values()].find(
      (r) => r.subscription?.endpoint === subscription.endpoint
    );
  }

  if (rec) {
    rec.subscription = subscription;
    if (typeof intervalMs === 'number') rec.intervalMs = intervalMs;
    if (userId) rec.userId = userId;
  } else {
    rec = {
      id: crypto.randomUUID(),
      userId: userId || null,
      subscription,
      intervalMs: typeof intervalMs === 'number' ? intervalMs : 60 * 60 * 1000,
      nextFireAt: null,
      running: false,
      lastFiredAt: null, // when the last key time fired while stopped (overdue marker)
      createdAt: Date.now(),
      history: [],
    };
  }
  await save('records', rec);
  return rec;
}

export async function setInterval_(id, intervalMs) {
  const rec = data.records.get(id);
  if (!rec) return null;
  rec.intervalMs = intervalMs;
  // If a timer is already running, re-base it to the new interval from now.
  if (rec.running) rec.nextFireAt = Date.now() + intervalMs;
  await save('records', rec);
  return rec;
}

export async function startTimer(id) {
  const rec = data.records.get(id);
  if (!rec) return null;
  rec.running = true;
  rec.nextFireAt = Date.now() + rec.intervalMs;
  rec.lastFiredAt = null; // restarting clears the "overdue since last key time" marker
  await save('records', rec);
  return rec;
}

export async function stopTimer(id) {
  const rec = data.records.get(id);
  if (!rec) return null;
  rec.running = false;
  rec.nextFireAt = null;
  rec.lastFiredAt = null; // a manual stop is not "overdue" — clear the marker
  await save('records', rec);
  return rec;
}

/**
 * Mark a key time as fired: log it in history and STOP the timer.
 * The next timer only restarts when the user opens the notification and
 * calls startTimer again.
 */
export async function recordFire(id, firedAt = Date.now(), { overdue = true } = {}) {
  const rec = data.records.get(id);
  if (!rec) return null;
  rec.history.push({ firedAt });
  rec.running = false;
  rec.nextFireAt = null;
  // The overdue clock only applies when the timer elapsed on its own. A manual
  // "Key time now" is intentional, so it doesn't count as overdue.
  rec.lastFiredAt = overdue ? firedAt : null;
  await save('records', rec);
  return rec;
}

/** Remove a single key-time entry from a record's history (by its timestamp). */
export async function removeHistoryEntry(id, firedAt) {
  const rec = data.records.get(id);
  if (!rec) return null;
  const idx = rec.history.findIndex((h) => h.firedAt === firedAt);
  if (idx === -1) return rec;
  rec.history.splice(idx, 1);
  await save('records', rec);
  return rec;
}

/** End the session: clear history and stop the timer. Keeps interval + subscription. */
export async function clearSession(id) {
  const rec = data.records.get(id);
  if (!rec) return null;
  rec.history = [];
  rec.running = false;
  rec.nextFireAt = null;
  rec.lastFiredAt = null;
  await save('records', rec);
  return rec;
}

export async function removeRecord(id) {
  return drop('records', id);
}

// =========================================================================
// Users (accounts)
// =========================================================================
export function getUser(id) {
  return data.users.get(id) || null;
}

export function getUserByUsername(username) {
  const u = String(username).toLowerCase();
  return [...data.users.values()].find((x) => x.username.toLowerCase() === u) || null;
}

export async function createUser({ username, passwordHash = null }) {
  const user = {
    id: crypto.randomUUID(),
    username,
    passwordHash,
    createdAt: Date.now(),
  };
  await save('users', user);
  return user;
}

export async function setUserPassword(id, passwordHash) {
  const user = data.users.get(id);
  if (!user) return null;
  user.passwordHash = passwordHash;
  await save('users', user);
  return user;
}

export async function setUsername(id, username) {
  const user = data.users.get(id);
  if (!user) return null;
  user.username = username;
  await save('users', user);
  return user;
}

// =========================================================================
// Friendships
// =========================================================================
export function getFriendship(id) {
  return data.friendships.get(id) || null;
}

/** The friendship between two users, in either direction (or null). */
export function friendshipBetween(a, b) {
  return (
    [...data.friendships.values()].find(
      (f) =>
        (f.requester === a && f.addressee === b) ||
        (f.requester === b && f.addressee === a)
    ) || null
  );
}

/** All friendships (any status) that involve this user. */
export function friendshipsFor(userId) {
  return [...data.friendships.values()].filter(
    (f) => f.requester === userId || f.addressee === userId
  );
}

export async function createFriendship({ requester, addressee, status = 'pending' }) {
  const f = {
    id: crypto.randomUUID(),
    requester,
    addressee,
    status,
    createdAt: Date.now(),
  };
  await save('friendships', f);
  return f;
}

export async function saveFriendship(f) {
  await save('friendships', f);
  return f;
}

export async function removeFriendship(id) {
  return drop('friendships', id);
}

// =========================================================================
// Invites ("wanna have a key time?")
// =========================================================================
export function getInvite(id) {
  return data.invites.get(id) || null;
}

export function invitesFrom(userId) {
  return [...data.invites.values()].filter((i) => i.from === userId);
}

export function invitesTo(userId) {
  return [...data.invites.values()].filter((i) => i.to === userId);
}

export function invitesByEvent(eventId) {
  return [...data.invites.values()].filter((i) => i.eventId === eventId);
}

export function invitesForGroup(groupId) {
  return [...data.invites.values()].filter((i) => i.groupId === groupId);
}

export async function createInvite({ from, to, message = '', groupId = null, eventId = null, status = 'pending' }) {
  const inv = {
    id: crypto.randomUUID(),
    from,
    to,
    message,
    status,
    createdAt: Date.now(),
    respondedAt: null,
    respondedBy: null,
    hiddenFor: [], // userIds who dismissed it from their own list
    groupId,       // set when this invite is part of a group key-time blast
    eventId,       // shared id linking all invites from one group blast
  };
  await save('invites', inv);
  return inv;
}

export async function saveInvite(inv) {
  await save('invites', inv);
  return inv;
}

export async function removeInvite(id) {
  return drop('invites', id);
}

// =========================================================================
// Sessions (saved summaries of ended key-time sessions)
// =========================================================================
export function getSession(id) {
  return data.sessions.get(id) || null;
}

export function sessionsFor(userId) {
  return [...data.sessions.values()]
    .filter((s) => s.userId === userId)
    .sort((a, b) => b.endedAt - a.endedAt);
}

export async function createSession(session) {
  const s = { id: crypto.randomUUID(), ...session };
  await save('sessions', s);
  return s;
}

export async function removeSession(id) {
  return drop('sessions', id);
}

// =========================================================================
// Groups
// =========================================================================
export function getGroup(id) {
  return data.groups.get(id) || null;
}

/** All groups this user is a member of. */
export function groupsForUser(userId) {
  return [...data.groups.values()].filter((g) => g.members.includes(userId));
}

export async function createGroup({ name, ownerId }) {
  const g = {
    id: crypto.randomUUID(),
    name,
    ownerId,
    members: [ownerId],
    invitedBy: {}, // memberId -> the member who added them (owner has no entry)
    createdAt: Date.now(),
  };
  await save('groups', g);
  return g;
}

export async function saveGroup(g) {
  await save('groups', g);
  return g;
}

export async function removeGroup(id) {
  return drop('groups', id);
}
