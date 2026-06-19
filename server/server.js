// Key Time server: serves the PWA and exposes the timer/push API.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Load .env if present (Node 20.6+). Harmless if the file is missing.
try {
  process.loadEnvFile();
} catch {
  /* no .env file — rely on real environment variables */
}

const { tick, pushToUser, getPublicKey, vapidConfigured } = await import('./push.js');
const store = await import('./store.js');
const auth = await import('./auth.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const TICK_SECRET = process.env.TICK_SECRET || '';

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// --- Public config -------------------------------------------------------
app.get('/api/config', (_req, res) => {
  res.json({ vapidPublicKey: getPublicKey(), pushEnabled: vapidConfigured });
});

// --- Auth ----------------------------------------------------------------
function authedUser(req) {
  const header = req.get('authorization') || '';
  const token = header.replace(/^Bearer /i, '') || req.get('x-auth-token');
  const userId = auth.verifyToken(token);
  return userId ? store.getUser(userId) : null;
}

// Resolves the user or sends 401. Returns null when unauthorized.
function requireUser(req, res) {
  const user = authedUser(req);
  if (!user) {
    res.status(401).json({ error: 'authentication required' });
    return null;
  }
  return user;
}

const publicUser = (u) => ({ id: u.id, username: u.username });

function validPassword(p) {
  return typeof p === 'string' && p.length >= 6;
}

// Create an account: unique username + password (so it works on any device).
app.post('/api/register', async (req, res) => {
  const username = String(req.body?.username || '').trim().replace(/\s+/g, ' ');
  const { password } = req.body || {};
  if (!auth.validUsername(username)) {
    return res.status(400).json({ error: "username: 3–20 chars — letters, digits, spaces, _ . ' -" });
  }
  if (!validPassword(password)) {
    return res.status(400).json({ error: 'password must be at least 6 characters' });
  }
  if (store.getUserByUsername(username)) {
    return res.status(409).json({ error: 'that username is taken' });
  }
  const user = await store.createUser({
    username,
    passwordHash: auth.hashPassword(password),
  });
  res.json({ token: auth.signToken(user.id), user: publicUser(user) });
});

// Log in from any device with username + password.
app.post('/api/login', (req, res) => {
  const username = String(req.body?.username || '').trim().replace(/\s+/g, ' ');
  const { password } = req.body || {};
  const user = store.getUserByUsername(username);
  if (!user || !user.passwordHash || !auth.verifyPassword(password || '', user.passwordHash)) {
    return res.status(401).json({ error: 'wrong username or password' });
  }
  res.json({ token: auth.signToken(user.id), user: publicUser(user) });
});

// Change the signed-in account's username (must stay unique).
app.post('/api/username', async (req, res) => {
  const me = requireUser(req, res);
  if (!me) return;
  const username = String(req.body?.username || '').trim().replace(/\s+/g, ' ');
  if (!auth.validUsername(username)) {
    return res.status(400).json({ error: "username: 3–20 chars — letters, digits, spaces, _ . ' -" });
  }
  const existing = store.getUserByUsername(username);
  if (existing && existing.id !== me.id) {
    return res.status(409).json({ error: 'that username is taken' });
  }
  const updated = await store.setUsername(me.id, username);
  res.json({ user: publicUser(updated) });
});

// Set or change the password for the signed-in account (lets device-only
// accounts add a password so they can log in elsewhere).
app.post('/api/password', async (req, res) => {
  const me = requireUser(req, res);
  if (!me) return;
  const { password } = req.body || {};
  if (!validPassword(password)) {
    return res.status(400).json({ error: 'password must be at least 6 characters' });
  }
  await store.setUserPassword(me.id, auth.hashPassword(password));
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  res.json({ user: publicUser(user), hasPassword: Boolean(user.passwordHash) });
});

// --- Friends -------------------------------------------------------------
app.get('/api/friends', (req, res) => {
  const me = requireUser(req, res);
  if (!me) return;
  const friends = [];
  const incoming = [];
  const outgoing = [];
  for (const f of store.friendshipsFor(me.id)) {
    const otherId = f.requester === me.id ? f.addressee : f.requester;
    const other = store.getUser(otherId);
    if (!other) continue;
    const entry = { friendshipId: f.id, user: publicUser(other) };
    if (f.status === 'accepted') friends.push(entry);
    else if (f.addressee === me.id) incoming.push(entry);
    else outgoing.push(entry);
  }
  res.json({ friends, incoming, outgoing });
});

app.post('/api/friends/request', async (req, res) => {
  const me = requireUser(req, res);
  if (!me) return;
  const username = String(req.body?.username || '').trim().replace(/\s+/g, ' ');
  const target = store.getUserByUsername(username);
  if (!target) return res.status(404).json({ error: 'no user with that name' });
  if (target.id === me.id) return res.status(400).json({ error: "that's you" });

  const existing = store.friendshipBetween(me.id, target.id);
  if (existing) {
    if (existing.status === 'accepted') {
      return res.status(409).json({ error: 'already friends' });
    }
    if (existing.requester === me.id) {
      return res.status(409).json({ error: 'request already sent' });
    }
    // They already requested me → accept it now.
    existing.status = 'accepted';
    await store.saveFriendship(existing);
    await pushToUser(target.id, {
      title: '🔑 Friend added',
      body: `${me.username} accepted your friend request.`,
      data: { url: './' },
    });
    return res.json({ status: 'accepted', user: publicUser(target) });
  }

  await store.createFriendship({ requester: me.id, addressee: target.id });
  await pushToUser(target.id, {
    title: '🔑 Friend request',
    body: `${me.username} wants to be your friend.`,
    data: { url: './?friends=1' },
  });
  res.json({ status: 'pending', user: publicUser(target) });
});

app.post('/api/friends/respond', async (req, res) => {
  const me = requireUser(req, res);
  if (!me) return;
  const { friendshipId, accept } = req.body || {};
  const f = store.getFriendship(friendshipId);
  if (!f || f.addressee !== me.id || f.status !== 'pending') {
    return res.status(404).json({ error: 'no such request' });
  }
  if (accept) {
    f.status = 'accepted';
    await store.saveFriendship(f);
    await pushToUser(f.requester, {
      title: '🔑 Friend added',
      body: `${me.username} accepted your friend request.`,
      data: { url: './' },
    });
    return res.json({ status: 'accepted' });
  }
  await store.removeFriendship(f.id);
  res.json({ status: 'declined' });
});

// --- Invites ("wanna have a key time?") ----------------------------------
app.get('/api/invites', (req, res) => {
  const me = requireUser(req, res);
  if (!me) return;
  const shape = (i, otherId) => {
    const u = store.getUser(otherId);
    return u
      ? {
          id: i.id,
          status: i.status,
          message: i.message || '',
          createdAt: i.createdAt,
          respondedAt: i.respondedAt || null,
          user: publicUser(u),
        }
      : null;
  };
  const incoming = store.invitesTo(me.id).map((i) => shape(i, i.from)).filter(Boolean);
  const outgoing = store.invitesFrom(me.id).map((i) => shape(i, i.to)).filter(Boolean);
  res.json({ incoming, outgoing });
});

app.post('/api/invite', async (req, res) => {
  const me = requireUser(req, res);
  if (!me) return;
  const friend = store.getUser(req.body?.toUserId);
  if (!friend) return res.status(404).json({ error: 'no such user' });
  const f = store.friendshipBetween(me.id, friend.id);
  if (!f || f.status !== 'accepted') {
    return res.status(403).json({ error: 'you can only invite friends' });
  }
  const dup = store
    .invitesFrom(me.id)
    .find((i) => i.to === friend.id && i.status === 'pending');
  if (dup) return res.status(409).json({ error: 'invite already pending' });

  const message = String(req.body?.message || '').trim().slice(0, 25);
  const inv = await store.createInvite({ from: me.id, to: friend.id, message });
  await pushToUser(friend.id, {
    title: '🔑 Wanna have a key time?',
    body: message
      ? `${me.username}: ${message}`
      : `${me.username} is inviting you to have key time together.`,
    data: { url: './?invites=1' },
  });
  res.json({ id: inv.id, status: inv.status, user: publicUser(friend) });
});

app.post('/api/invite/respond', async (req, res) => {
  const me = requireUser(req, res);
  if (!me) return;
  const { inviteId, accept } = req.body || {};
  const inv = store.getInvite(inviteId);
  // Recipient can respond any time the invite exists — including changing
  // their mind after a previous accept/decline.
  if (!inv || inv.to !== me.id) {
    return res.status(404).json({ error: 'no such invite' });
  }
  inv.status = accept ? 'accepted' : 'declined';
  inv.respondedAt = Date.now();
  await store.saveInvite(inv);
  const sender = store.getUser(inv.from);
  if (sender) {
    await pushToUser(sender.id, accept
      ? {
          title: `🔑 ${me.username} is in!`,
          body: `${me.username} accepted your key time invite.`,
          data: { url: './?invites=1' },
        }
      : {
          title: `${me.username} can't right now`,
          body: `${me.username} declined your key time invite.`,
          data: { url: './?invites=1' },
        });
  }
  res.json({ status: inv.status });
});

app.post('/api/invite/dismiss', async (req, res) => {
  const me = requireUser(req, res);
  if (!me) return;
  const inv = store.getInvite(req.body?.inviteId);
  if (!inv || (inv.from !== me.id && inv.to !== me.id)) {
    return res.status(404).json({ error: 'no such invite' });
  }
  await store.removeInvite(inv.id);
  res.json({ ok: true });
});

// --- Subscribe / settings ------------------------------------------------
app.post('/api/subscribe', async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const { id, subscription, intervalMs } = req.body || {};
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: 'subscription required' });
  }
  const rec = await store.upsertSubscription({
    id,
    subscription,
    intervalMs,
    userId: user.id,
  });
  res.json(publicState(rec));
});

app.post('/api/settings', async (req, res) => {
  const { id, intervalMs } = req.body || {};
  if (!id || typeof intervalMs !== 'number' || intervalMs <= 0) {
    return res.status(400).json({ error: 'id and positive intervalMs required' });
  }
  const rec = await store.setInterval_(id, intervalMs);
  if (!rec) return res.status(404).json({ error: 'not found' });
  res.json(publicState(rec));
});

// --- Timer control -------------------------------------------------------
app.post('/api/start', async (req, res) => {
  const rec = await store.startTimer(req.body?.id);
  if (!rec) return res.status(404).json({ error: 'not found' });
  res.json(publicState(rec));
});

app.post('/api/stop', async (req, res) => {
  const rec = await store.stopTimer(req.body?.id);
  if (!rec) return res.status(404).json({ error: 'not found' });
  res.json(publicState(rec));
});

// Manually trigger a key time now: log it in history and stop the timer,
// just like an automatic fire — for when key time comes early.
app.post('/api/fire', async (req, res) => {
  const rec = await store.recordFire(req.body?.id);
  if (!rec) return res.status(404).json({ error: 'not found' });
  res.json(publicState(rec));
});

// --- State / stats -------------------------------------------------------
app.get('/api/state', (req, res) => {
  const rec = store.getRecord(req.query.id);
  if (!rec) return res.status(404).json({ error: 'not found' });
  res.json(publicState(rec));
});

// --- Scheduler tick (external cron can hit this) -------------------------
app.post('/api/tick', async (req, res) => {
  if (TICK_SECRET && req.get('x-tick-secret') !== TICK_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const sent = await tick();
  res.json({ sent });
});

// End the session: build a report of what just happened, then clear it all.
app.post('/api/reset', async (req, res) => {
  const rec = store.getRecord(req.body?.id);
  if (!rec) return res.status(404).json({ error: 'not found' });
  const report = buildReport(rec.history);
  // Save the finished session to history (only if anything actually happened).
  if (report.count > 0 && rec.userId) {
    const description = String(req.body?.description || '').trim().slice(0, 120);
    await store.createSession({
      userId: rec.userId,
      description,
      endedAt: Date.now(),
      ...report,
    });
  }
  const cleared = await store.clearSession(rec.id);
  res.json({ report, state: publicState(cleared) });
});

app.get('/api/sessions', (req, res) => {
  const me = requireUser(req, res);
  if (!me) return;
  res.json({ sessions: store.sessionsFor(me.id) });
});

function buildReport(history) {
  const count = history.length;
  if (count === 0) return { count: 0 };
  const first = history[0].firedAt;
  const last = history[count - 1].firedAt;
  const durationMs = last - first;
  return {
    count,
    first,
    last,
    durationMs,
    avgGapMs: count > 1 ? Math.round(durationMs / (count - 1)) : null,
  };
}

function publicState(rec) {
  return {
    id: rec.id,
    intervalMs: rec.intervalMs,
    running: rec.running,
    nextFireAt: rec.nextFireAt,
    serverNow: Date.now(),
    history: rec.history,
  };
}

// In-process scheduler: fine for local dev and always-on hosts.
// On hosts that sleep (e.g. Render free tier), also ping POST /api/tick
// from an external cron so timers fire while the app is idle.
const TICK_INTERVAL_MS = 15 * 1000;
setInterval(() => {
  tick().catch((err) => console.error('[tick]', err));
}, TICK_INTERVAL_MS);

await store.init();

app.listen(PORT, () => {
  console.log(`Key Time running on http://localhost:${PORT}`);
  if (!vapidConfigured) {
    console.log('Push disabled — run `npm run gen-vapid` and add keys to .env.');
  }
});
