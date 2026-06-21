// Key Time server: serves the PWA and exposes the timer/push API.
import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
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

// Resolves a timer record the caller is allowed to touch, or sends 401/404/403
// and returns null. Ownerless (legacy) records are allowed so no one is locked
// out; records owned by someone else are rejected.
function requireOwnedRecord(req, res, id) {
  const me = requireUser(req, res);
  if (!me) return null;
  const rec = store.getRecord(id);
  if (!rec) {
    res.status(404).json({ error: 'not found' });
    return null;
  }
  if (rec.userId && rec.userId !== me.id) {
    res.status(403).json({ error: 'not your timer' });
    return null;
  }
  return rec;
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
    return res.status(400).json({ error: "username: 3–15 chars — letters, digits, spaces, _ . ' -" });
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
  res.json({ token: auth.signToken(user.id), user: publicUser(user), createdAt: user.createdAt });
});

// Log in from any device with username + password.
app.post('/api/login', (req, res) => {
  const username = String(req.body?.username || '').trim().replace(/\s+/g, ' ');
  const { password } = req.body || {};
  const user = store.getUserByUsername(username);
  if (!user || !user.passwordHash || !auth.verifyPassword(password || '', user.passwordHash)) {
    return res.status(401).json({ error: 'wrong username or password' });
  }
  res.json({ token: auth.signToken(user.id), user: publicUser(user), createdAt: user.createdAt });
});

// Change the signed-in account's username (must stay unique).
app.post('/api/username', async (req, res) => {
  const me = requireUser(req, res);
  if (!me) return;
  const username = String(req.body?.username || '').trim().replace(/\s+/g, ' ');
  if (!auth.validUsername(username)) {
    return res.status(400).json({ error: "username: 3–15 chars — letters, digits, spaces, _ . ' -" });
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
  res.json({ user: publicUser(user), hasPassword: Boolean(user.passwordHash), createdAt: user.createdAt });
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

app.post('/api/friends/remove', async (req, res) => {
  const me = requireUser(req, res);
  if (!me) return;
  const other = store.getUser(req.body?.userId);
  if (!other) return res.status(404).json({ error: 'no such user' });
  const f = store.friendshipBetween(me.id, other.id);
  if (!f) return res.status(404).json({ error: 'not friends' });
  await store.removeFriendship(f.id);
  // Clear any direct 1:1 key-time invites between us so they don't linger as
  // orphaned (e.g. a stale "pending" that would later block re-inviting). Group
  // invites (eventId set) are tied to the group, not the friendship — leave them.
  for (const inv of [...store.invitesFrom(me.id), ...store.invitesTo(me.id)]) {
    const between = (inv.from === me.id && inv.to === other.id) ||
      (inv.from === other.id && inv.to === me.id);
    if (between && !inv.eventId) await store.removeInvite(inv.id);
  }
  res.json({ ok: true });
});

// --- Invites ("wanna have a key time?") ----------------------------------
app.get('/api/invites', (req, res) => {
  const me = requireUser(req, res);
  if (!me) return;
  const visible = (i) => !(i.hiddenFor || []).includes(me.id);

  // Group key-time invite aggregate. The initiator participates via a self-invite
  // (to === from), so they're counted like everyone else. Legacy events created
  // before self-invites existed get the old +1-for-the-sender fallback.
  const eventInfo = (eventId) => {
    if (!eventId) return null;
    const all = store.invitesByEvent(eventId);
    const senderId = all[0]?.from;
    const hasSelf = all.some((i) => i.to === senderId);
    const base = hasSelf ? 0 : 1;
    const accepted = all.filter((x) => x.status === 'accepted').length + base;
    const mine = all.find((i) => i.to === me.id);
    return {
      id: eventId,
      total: all.length + base,
      accepted,
      myInviteId: mine?.id || null,
      myStatus: mine?.status || null,
    };
  };
  const groupInfo = (groupId) => {
    if (!groupId) return null;
    const g = store.getGroup(groupId);
    return g ? { id: g.id, name: g.name } : null;
  };

  const shape = (i, otherId) => {
    const u = store.getUser(otherId);
    return u
      ? {
          id: i.id,
          status: i.status,
          message: i.message || '',
          createdAt: i.createdAt,
          respondedAt: i.respondedAt || null,
          respondedBy: i.respondedBy || null,
          user: publicUser(u),
          group: groupInfo(i.groupId),
          event: eventInfo(i.eventId),
        }
      : null;
  };

  // A group initiator's self-invite (from === to === me) belongs in their
  // outgoing row, not incoming — exclude it here.
  const incoming = store
    .invitesTo(me.id)
    .filter(visible)
    .filter((i) => i.from !== me.id)
    .map((i) => shape(i, i.from))
    .filter(Boolean);

  // Outgoing: collapse a whole-group blast (shared eventId) into one row.
  const seenEvents = new Set();
  const outgoing = [];
  for (const i of store.invitesFrom(me.id).filter(visible)) {
    if (i.eventId) {
      if (seenEvents.has(i.eventId)) continue;
      seenEvents.add(i.eventId);
    }
    const row = shape(i, i.to);
    if (row) outgoing.push(row);
  }

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
  const message = String(req.body?.message || '').trim().slice(0, 25);

  // If a 1:1 invite to this friend is still pending, refresh it in place (update
  // the note, bump the time, re-show it) instead of stacking a second one.
  const pending = store
    .invitesFrom(me.id)
    .find((i) => i.to === friend.id && i.status === 'pending' && !i.eventId);
  let inv;
  if (pending) {
    pending.message = message;
    pending.createdAt = Date.now();
    pending.hiddenFor = []; // un-hide it for either side after a re-send
    inv = await store.saveInvite(pending);
  } else {
    // Otherwise drop any earlier *resolved* invite (so accepted/declined ones
    // don't pile up) and create a fresh invite that shows up in the list.
    for (const old of store.invitesFrom(me.id)) {
      if (old.to === friend.id && !old.eventId) await store.removeInvite(old.id);
    }
    inv = await store.createInvite({ from: me.id, to: friend.id, message });
  }

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
  // Either party can respond any time the invite exists. The recipient can
  // accept or decline (and change their mind); the sender can only cancel
  // (decline) — which keeps the invite visible to the recipient as "declined".
  if (!inv || (inv.to !== me.id && inv.from !== me.id)) {
    return res.status(404).json({ error: 'no such invite' });
  }
  const isRecipient = inv.to === me.id;
  inv.status = isRecipient && accept ? 'accepted' : 'declined';
  inv.respondedAt = Date.now();
  inv.respondedBy = me.id;
  await store.saveInvite(inv);

  const otherId = isRecipient ? inv.from : inv.to;
  const other = store.getUser(otherId);
  // Skip notifying yourself (a group initiator's self-invite has from === to).
  if (other && other.id !== me.id) {
    let payload;
    if (isRecipient) {
      payload = accept
        ? { title: `🔑 ${me.username} is in!`, body: `${me.username} accepted your key time invite.` }
        : { title: `🔑 ${me.username} can't right now`, body: `${me.username} declined your key time invite.` };
    } else {
      payload = { title: `🔑 ${me.username} cancelled`, body: `${me.username} cancelled the key time invite.` };
    }
    payload.data = { url: './?invites=1' };
    await pushToUser(other.id, payload);
  }
  res.json({ status: inv.status });
});

app.post('/api/invite/dismiss', async (req, res) => {
  const me = requireUser(req, res);
  if (!me) return;

  // Hide from my own list only — the other party keeps seeing it. Once both
  // sides have dismissed it, drop the record entirely.
  const hideFromMe = async (inv) => {
    // If I'm the recipient and never responded, dismissing it counts as a
    // decline so the sender (and the rest of a group) see it as declined.
    if (inv.to === me.id && inv.status === 'pending') {
      inv.status = 'declined';
      inv.respondedAt = Date.now();
      inv.respondedBy = me.id;
    }
    inv.hiddenFor = [...new Set([...(inv.hiddenFor || []), me.id])];
    if (inv.hiddenFor.includes(inv.from) && inv.hiddenFor.includes(inv.to)) {
      await store.removeInvite(inv.id);
    } else {
      await store.saveInvite(inv);
    }
  };

  // A whole group blast can be cleared by its eventId. The initiator clearing it
  // cancels the key time for everyone (and frees the group for a new one); a
  // recipient clearing it just drops themselves out.
  if (req.body?.eventId) {
    const all = store.invitesByEvent(req.body.eventId);
    const mine = all.filter((i) => i.from === me.id || i.to === me.id);
    if (!mine.length) return res.status(404).json({ error: 'no such invite' });
    const isInitiator = all[0].from === me.id;
    if (isInitiator) {
      const g = store.getGroup(all[0].groupId);
      for (const inv of all) {
        // Let anyone who'd already accepted know it's off.
        if (inv.to !== me.id && inv.status === 'accepted') {
          await pushToUser(inv.to, {
            title: '🔑 Group key time cancelled',
            body: `${me.username} cancelled the ${g ? `"${g.name}" ` : ''}key time.`,
            data: { url: './?invites=1' },
          });
        }
        await store.removeInvite(inv.id);
      }
    } else {
      for (const inv of mine) await hideFromMe(inv);
    }
    return res.json({ ok: true });
  }

  const inv = store.getInvite(req.body?.inviteId);
  if (!inv || (inv.from !== me.id && inv.to !== me.id)) {
    return res.status(404).json({ error: 'no such invite' });
  }
  await hideFromMe(inv);
  res.json({ ok: true });
});

// Per-member breakdown of a group key-time invite (lazy-loaded behind a toggle).
app.get('/api/event', (req, res) => {
  const me = requireUser(req, res);
  if (!me) return;
  const all = store.invitesByEvent(req.query?.eventId);
  if (!all.length) return res.status(404).json({ error: 'no such event' });
  const senderId = all[0].from;
  // Only participants (the sender or a recipient) may see who responded.
  const isParticipant = senderId === me.id || all.some((i) => i.to === me.id);
  if (!isParticipant) return res.status(403).json({ error: 'not your event' });

  const g = store.getGroup(all[0].groupId);
  const sender = store.getUser(senderId);
  const selfInvite = all.find((i) => i.to === senderId); // initiator's own RSVP
  const members = [];
  // Initiator first, carrying their own status (accepted by default; declined if
  // they later dropped out). Legacy events without a self-invite default to in.
  if (sender) {
    members.push({ user: publicUser(sender), status: selfInvite ? selfInvite.status : 'accepted' });
  }
  for (const i of all) {
    if (i.to === senderId) continue; // already added as the initiator
    const u = store.getUser(i.to);
    if (u) members.push({ user: publicUser(u), status: i.status });
  }
  res.json({
    group: g ? { id: g.id, name: g.name } : null,
    from: sender ? publicUser(sender) : null,
    members,
  });
});

// --- Groups --------------------------------------------------------------
app.get('/api/groups', (req, res) => {
  const me = requireUser(req, res);
  if (!me) return;
  const groups = store.groupsForUser(me.id).map((g) => ({
    id: g.id,
    name: g.name,
    ownerId: g.ownerId,
    isOwner: g.ownerId === me.id,
    invitedBy: g.invitedBy || {}, // memberId -> who added them
    members: g.members.map((id) => store.getUser(id)).filter(Boolean).map(publicUser),
  }));
  res.json({ groups });
});

app.post('/api/groups', async (req, res) => {
  const me = requireUser(req, res);
  if (!me) return;
  const name = String(req.body?.name || '').trim().replace(/\s+/g, ' ').slice(0, 15);
  if (name.length < 2) return res.status(400).json({ error: 'group name: 2–15 characters' });
  // A group needs members — require at least one accepted friend to add.
  const hasFriend = store.friendshipsFor(me.id).some((f) => f.status === 'accepted');
  if (!hasFriend) return res.status(400).json({ error: 'add a friend first' });
  const g = await store.createGroup({ name, ownerId: me.id });
  res.json({ id: g.id, name: g.name });
});

app.post('/api/groups/invite', async (req, res) => {
  const me = requireUser(req, res);
  if (!me) return;
  const g = store.getGroup(req.body?.groupId);
  if (!g || !g.members.includes(me.id)) return res.status(404).json({ error: 'no such group' });
  const target = store.getUser(req.body?.userId);
  if (!target) return res.status(404).json({ error: 'no such user' });
  const f = store.friendshipBetween(me.id, target.id);
  if (!f || f.status !== 'accepted') {
    return res.status(403).json({ error: 'you can only add friends to a group' });
  }
  if (g.members.includes(target.id)) return res.status(409).json({ error: 'already a member' });

  // Add the friend straight into the group — no invitation/acceptance step.
  g.members.push(target.id);
  g.invitedBy = { ...(g.invitedBy || {}), [target.id]: me.id };
  await store.saveGroup(g);
  await pushToUser(target.id, {
    title: '🔑 Added to group',
    body: `${me.username} added you to "${g.name}".`,
    data: { url: './?friends=1' },
  });
  res.json({ ok: true, user: publicUser(target) });
});

// Rename a group — creator only.
app.post('/api/groups/rename', async (req, res) => {
  const me = requireUser(req, res);
  if (!me) return;
  const g = store.getGroup(req.body?.groupId);
  if (!g) return res.status(404).json({ error: 'no such group' });
  if (g.ownerId !== me.id) return res.status(403).json({ error: 'only the creator can rename' });
  const name = String(req.body?.name || '').trim().replace(/\s+/g, ' ').slice(0, 15);
  if (name.length < 2) return res.status(400).json({ error: 'group name: 2–15 characters' });
  g.name = name;
  await store.saveGroup(g);
  res.json({ id: g.id, name: g.name });
});

app.post('/api/groups/leave', async (req, res) => {
  const me = requireUser(req, res);
  if (!me) return;
  const g = store.getGroup(req.body?.groupId);
  if (!g || !g.members.includes(me.id)) return res.status(404).json({ error: 'no such group' });
  if (g.ownerId === me.id) {
    return res.status(400).json({ error: 'the creator must delete the group instead' });
  }
  g.members = g.members.filter((id) => id !== me.id);
  if (g.invitedBy) delete g.invitedBy[me.id];
  await store.saveGroup(g);
  // Drop my own group key-time invites so they don't linger as a pending invite
  // that blocks future group key times.
  for (const inv of store.invitesForGroup(g.id)) {
    if (inv.to === me.id) await store.removeInvite(inv.id);
  }
  res.json({ ok: true });
});

// Remove a member from the group. The creator can remove anyone; a regular
// member can remove only people they personally added.
app.post('/api/groups/kick', async (req, res) => {
  const me = requireUser(req, res);
  if (!me) return;
  const g = store.getGroup(req.body?.groupId);
  if (!g || !g.members.includes(me.id)) return res.status(404).json({ error: 'no such group' });
  const userId = req.body?.userId;
  if (userId === me.id) return res.status(400).json({ error: "you can't remove yourself" });
  if (!g.members.includes(userId)) return res.status(404).json({ error: 'not a member' });

  const invitedBy = g.invitedBy || {};
  const canRemove = g.ownerId === me.id || invitedBy[userId] === me.id;
  if (!canRemove) {
    return res.status(403).json({ error: 'you can only remove members you added' });
  }

  g.members = g.members.filter((id) => id !== userId);
  if (g.invitedBy) delete g.invitedBy[userId];
  await store.saveGroup(g);
  // Drop any group key-time invites addressed to the removed member so a dangling
  // pending invite can't block future group key times.
  for (const inv of store.invitesForGroup(g.id)) {
    if (inv.to === userId) await store.removeInvite(inv.id);
  }
  await pushToUser(userId, {
    title: '🔑 Removed from group',
    body: `${me.username} removed you from "${g.name}".`,
    data: { url: './?friends=1' },
  });
  res.json({ ok: true });
});

app.post('/api/groups/delete', async (req, res) => {
  const me = requireUser(req, res);
  if (!me) return;
  const g = store.getGroup(req.body?.groupId);
  if (!g) return res.status(404).json({ error: 'no such group' });
  if (g.ownerId !== me.id) return res.status(403).json({ error: 'only the creator can delete' });
  // Clear any key-time invites tied to this group so they don't linger as
  // orphaned (group-less) invites in people's lists.
  for (const inv of store.invitesForGroup(g.id)) await store.removeInvite(inv.id);
  await store.removeGroup(g.id);
  res.json({ ok: true });
});

// Invite the whole group to a key time. Bypasses the friends-only rule so you
// can reach group members you haven't friended.
app.post('/api/groups/keytime', async (req, res) => {
  const me = requireUser(req, res);
  if (!me) return;
  const g = store.getGroup(req.body?.groupId);
  if (!g || !g.members.includes(me.id)) return res.status(404).json({ error: 'no such group' });
  const message = String(req.body?.message || '').trim().slice(0, 25);
  const recipients = g.members.filter((id) => id !== me.id);
  if (!recipients.length) return res.status(400).json({ error: 'no one else in the group yet' });

  // Only one active group key time at a time: block a new blast while an earlier
  // one still has a *current* member who hasn't responded yet. Invites addressed
  // to people who have since left or been removed don't count (they can never be
  // resolved), so they can't wedge the group forever.
  const active = store
    .invitesForGroup(g.id)
    .some((i) => i.eventId && i.status === 'pending' && g.members.includes(i.to));
  if (active) {
    return res.status(409).json({ error: 'a group key time is already active — wait for it to wrap up' });
  }

  const eventId = crypto.randomUUID();
  // The initiator joins their own event as an accepted self-invite, so they can
  // later drop out (decline) without cancelling the key time for everyone else.
  await store.createInvite({
    from: me.id,
    to: me.id,
    message,
    groupId: g.id,
    eventId,
    status: 'accepted',
  });
  for (const uid of recipients) {
    await store.createInvite({ from: me.id, to: uid, message, groupId: g.id, eventId });
    await pushToUser(uid, {
      title: `🔑 Group key time: ${g.name}`,
      body: message
        ? `${me.username}: ${message}`
        : `${me.username} invited "${g.name}" to have key time together.`,
      data: { url: './?invites=1' },
    });
  }
  res.json({ eventId, sent: recipients.length });
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
  if (typeof intervalMs !== 'number' || intervalMs <= 0) {
    return res.status(400).json({ error: 'positive intervalMs required' });
  }
  if (!requireOwnedRecord(req, res, id)) return;
  const rec = await store.setInterval_(id, intervalMs);
  res.json(publicState(rec));
});

// --- Timer control -------------------------------------------------------
app.post('/api/start', async (req, res) => {
  if (!requireOwnedRecord(req, res, req.body?.id)) return;
  const rec = await store.startTimer(req.body?.id);
  res.json(publicState(rec));
});

app.post('/api/stop', async (req, res) => {
  if (!requireOwnedRecord(req, res, req.body?.id)) return;
  const rec = await store.stopTimer(req.body?.id);
  res.json(publicState(rec));
});

// Manually trigger a key time now: log it in history and stop the timer,
// just like an automatic fire — for when key time comes early.
app.post('/api/fire', async (req, res) => {
  if (!requireOwnedRecord(req, res, req.body?.id)) return;
  // Manual "Key time now" — intentional, so it's not flagged as overdue.
  const rec = await store.recordFire(req.body?.id, undefined, { overdue: false });
  res.json(publicState(rec));
});

// Remove a single key-time entry from the current session's history.
app.post('/api/history/remove', async (req, res) => {
  const rec = requireOwnedRecord(req, res, req.body?.id);
  if (!rec) return;
  const firedAt = req.body?.firedAt;
  if (typeof firedAt !== 'number') return res.status(400).json({ error: 'firedAt required' });
  const updated = await store.removeHistoryEntry(rec.id, firedAt);
  res.json(publicState(updated));
});

// --- State / stats -------------------------------------------------------
app.get('/api/state', (req, res) => {
  if (!requireOwnedRecord(req, res, req.query.id)) return;
  const rec = store.getRecord(req.query.id);
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
  const rec = requireOwnedRecord(req, res, req.body?.id);
  if (!rec) return;
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

// Delete a saved session from history.
app.post('/api/sessions/remove', async (req, res) => {
  const me = requireUser(req, res);
  if (!me) return;
  const s = store.getSession(req.body?.sessionId);
  if (!s || s.userId !== me.id) return res.status(404).json({ error: 'no such session' });
  await store.removeSession(s.id);
  res.json({ ok: true });
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
    lastFiredAt: rec.lastFiredAt || null,
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
