// Key Time — client logic.
const $ = (id) => document.getElementById(id);

const els = {
  banner: $('keytime-banner'),
  bannerStart: $('banner-start'),
  statusText: $('status-text'),
  countdown: $('countdown'),
  startBtn: $('start-btn'),
  fireBtn: $('fire-btn'),
  stopBtn: $('stop-btn'),
  enableHint: $('enable-hint'),
  enableBtn: $('enable-btn'),
  intervalValue: $('interval-value'),
  intervalUnit: $('interval-unit'),
  saveSettings: $('save-settings'),
  settingsMsg: $('settings-msg'),
  settingsToggle: $('settings-toggle'),
  intervalEditor: $('interval-editor'),
  intervalSummary: $('interval-summary'),
  statCount: $('stat-count'),
  statSession: $('stat-session'),
  statAvg: $('stat-avg'),
  statFirst: $('stat-first'),
  statLast: $('stat-last'),
  historyList: $('history-list'),
  historyEmpty: $('history-empty'),
  resetBtn: $('reset-btn'),
  sessionsList: $('sessions-list'),
  sessionsEmpty: $('sessions-empty'),
  endsessionModal: $('endsession-modal'),
  esCount: $('es-count'),
  esDuration: $('es-duration'),
  esAvg: $('es-avg'),
  esFirst: $('es-first'),
  esLast: $('es-last'),
  endsessionDesc: $('endsession-desc'),
  endsessionCancel: $('endsession-cancel'),
  endsessionConfirm: $('endsession-confirm'),
  connStatus: $('conn-status'),
  authScreen: $('auth-screen'),
  authForm: $('auth-form'),
  authTitle: $('auth-title'),
  authSub: $('auth-sub'),
  authUsername: $('auth-username'),
  authPassword: $('auth-password'),
  authSubmit: $('auth-submit'),
  authMsg: $('auth-msg'),
  authSwitch: $('auth-switch'),
  authSwitchText: $('auth-switch-text'),
  nameInput: $('name-input'),
  nameSave: $('name-save'),
  nameMsg: $('name-msg'),
  pwHeading: $('pw-heading'),
  pwHint: $('pw-hint'),
  pwInput: $('pw-input'),
  pwSave: $('pw-save'),
  pwMsg: $('pw-msg'),
  tabs: $('tabs'),
  header: document.querySelector('.header'),
  appBody: $('app-body'),
  accountBar: $('account-bar'),
  accountName: $('account-name'),
  accountCreated: $('account-created'),
  logoutBtn: $('logout-btn'),
  friendsCard: $('friends-card'),
  friendUsername: $('friend-username'),
  friendAddBtn: $('friend-add-btn'),
  friendMsg: $('friend-msg'),
  requestsSection: $('requests-section'),
  requestsList: $('requests-list'),
  friendsList: $('friends-list'),
  friendsEmpty: $('friends-empty'),
  qrBox: $('qr-box'),
  invitesIncomingSection: $('invites-incoming-section'),
  invitesIncoming: $('invites-incoming'),
  invitesOutgoingSection: $('invites-outgoing-section'),
  invitesOutgoing: $('invites-outgoing'),
  invitesEmpty: $('invites-empty'),
  invitesCard: $('invites-card'),
  inviteModal: $('invite-modal'),
  inviteModalTitle: $('invite-modal-title'),
  inviteMessage: $('invite-message'),
  inviteFriends: $('invite-friends'),
  inviteCancel: $('invite-cancel'),
  inviteSend: $('invite-send'),
  groupName: $('group-name'),
  groupCreateBtn: $('group-create-btn'),
  groupMsg: $('group-msg'),
  groupInvitesSection: $('group-invites-section'),
  groupInvites: $('group-invites'),
  groupsList: $('groups-list'),
  groupsEmpty: $('groups-empty'),
  groupKeytimeModal: $('group-keytime-modal'),
  groupKeytimeTitle: $('group-keytime-title'),
  groupKeytimeMessage: $('group-keytime-message'),
  groupKeytimeCancel: $('group-keytime-cancel'),
  groupKeytimeSend: $('group-keytime-send'),
  groupInviteModal: $('group-invite-modal'),
  groupInviteTitle: $('group-invite-title'),
  groupInviteFriends: $('group-invite-friends'),
  groupInviteEmpty: $('group-invite-empty'),
  groupInviteCancel: $('group-invite-cancel'),
  groupInviteSend: $('group-invite-send'),
};

const ID_KEY = 'keytime.id';
const INTERVAL_KEY = 'keytime.intervalMs';
const TOKEN_KEY = 'keytime.token';

const state = {
  id: localStorage.getItem(ID_KEY) || null,
  token: localStorage.getItem(TOKEN_KEY) || null,
  user: null,
  accountCreatedAt: null, // when this account was created (epoch ms)
  hasPassword: false,
  authMode: 'register', // or 'login'
  config: null,
  friends: [],        // latest accepted friends (for the invite picker)
  groups: [],         // latest groups I'm in
  groupTarget: null,  // group id while a group modal is open
  server: null,       // last /api/state response
  clockOffset: 0,     // serverNow - clientNow
  started: false,     // app (post-login) initialized once
};

// --- API helpers ---------------------------------------------------------
async function api(path, method = 'GET', body) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (state.token) headers['Authorization'] = `Bearer ${state.token}`;
  const res = await fetch(path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error || ''; } catch {}
    const err = new Error(`${path} -> ${res.status}`);
    err.status = res.status;
    err.detail = detail;
    throw err;
  }
  return res.json();
}

function applyServerState(s) {
  state.server = s;
  state.clockOffset = s.serverNow - Date.now();
  if (typeof s.intervalMs === 'number') {
    localStorage.setItem(INTERVAL_KEY, String(s.intervalMs));
  }
  render();
}

// --- Service worker + push ----------------------------------------------
function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

async function registerSW() {
  if (!('serviceWorker' in navigator)) return null;
  const reg = await navigator.serviceWorker.register('./sw.js');
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'keytime') showBanner();
  });
  return reg;
}

async function ensureSubscription() {
  if (!state.config?.pushEnabled) return;
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  if (Notification.permission !== 'granted') return;

  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(state.config.vapidPublicKey),
    });
  }

  const intervalMs = Number(localStorage.getItem(INTERVAL_KEY)) || undefined;
  const s = await api('/api/subscribe', 'POST', {
    id: state.id,
    subscription: sub.toJSON(),
    intervalMs,
  });
  state.id = s.id;
  localStorage.setItem(ID_KEY, s.id);
  applyServerState(s);
}

async function enableNotifications() {
  if (Notification.permission === 'denied') {
    els.settingsMsg.textContent =
      'Notifications are blocked in your browser settings — enable them there first.';
    return;
  }
  const perm = await Notification.requestPermission();
  if (perm === 'granted') {
    await ensureSubscription();
    render();
  }
}

// --- Rendering -----------------------------------------------------------
function pad(n) { return String(n).padStart(2, '0'); }

function fmtDuration(ms) {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

function fmtLongDuration(ms) {
  if (ms == null) return '—';
  const min = Math.round(ms / 60000);
  if (min < 1) return '<1m';
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m && !d) parts.push(`${m}m`);
  return parts.join(' ') || '<1m';
}

function fmtTime(ts) {
  return new Date(ts).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function fmtGap(ms) {
  const min = Math.round(ms / 60000);
  if (min < 60) return `+${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `+${h}h ${m}m` : `+${h}h`;
}

function pushReady() {
  return state.config?.pushEnabled && Notification.permission === 'granted' && state.id;
}

function render() {
  // Notification enable hint
  const needsEnable = state.config?.pushEnabled && Notification.permission !== 'granted';
  els.enableHint.classList.toggle('hidden', !needsEnable);
  if (state.config && !state.config.pushEnabled) {
    els.enableHint.classList.remove('hidden');
    els.enableHint.textContent = 'Push is not configured on the server (missing VAPID keys).';
    els.enableBtn?.remove();
  }

  const s = state.server;
  const running = !!s?.running;

  els.startBtn.disabled = !pushReady();
  els.startBtn.textContent = running ? 'Restart timer' : 'Start timer';
  els.fireBtn.classList.toggle('hidden', !running);
  els.stopBtn.classList.toggle('hidden', !running);

  els.statusText.textContent = running ? 'Running' : (s ? 'Waiting' : '—');
  els.statusText.className = 'status-pill ' + (running ? 'running' : (s ? 'waiting' : ''));

  // Show the reset button only when there's an active session to end.
  const hasSession = running || (s?.history?.length > 0);
  els.resetBtn.classList.toggle('hidden', !hasSession);

  updateIntervalSummary();
  renderStats();
  updateCountdown();
}

function renderStats() {
  const hist = state.server?.history || [];
  els.statCount.textContent = String(hist.length);
  els.historyEmpty.classList.toggle('hidden', hist.length > 0);

  if (hist.length) {
    els.statFirst.textContent = fmtTime(hist[0].firedAt);
    els.statLast.textContent = fmtTime(hist[hist.length - 1].firedAt);
  } else {
    els.statFirst.textContent = '—';
    els.statLast.textContent = '—';
  }

  // Average gap between consecutive key times.
  if (hist.length > 1) {
    const span = hist[hist.length - 1].firedAt - hist[0].firedAt;
    els.statAvg.textContent = fmtLongDuration(Math.round(span / (hist.length - 1)));
  } else {
    els.statAvg.textContent = '—';
  }

  updateSessionTime();

  els.historyList.innerHTML = '';
  // newest first
  [...hist].reverse().forEach((h, i) => {
    const idxFromStart = hist.length - i;
    const li = document.createElement('li');
    const left = document.createElement('span');
    left.innerHTML = `<span class="idx">#${idxFromStart}</span>${fmtTime(h.firedAt)}`;

    const right = document.createElement('span');
    right.className = 'hist-right';
    const gap = document.createElement('span');
    gap.className = 'gap';
    const realIdx = idxFromStart - 1;
    gap.textContent = realIdx > 0 ? fmtGap(h.firedAt - hist[realIdx - 1].firedAt) : 'first';
    const del = document.createElement('button');
    del.className = 'hist-remove';
    del.textContent = '✕';
    del.setAttribute('aria-label', 'Remove this key time');
    del.onclick = () => removeHistoryEntry(h.firedAt);
    right.append(gap, del);

    li.append(left, right);
    els.historyList.append(li);
  });
}

function updateCountdown() {
  const s = state.server;
  if (s?.running && s.nextFireAt) {
    const remaining = s.nextFireAt - (Date.now() + state.clockOffset);
    els.countdown.textContent = remaining > 0 ? fmtDuration(remaining) : 'firing…';
  } else {
    els.countdown.textContent = '--:--:--';
  }
  updateSessionTime();
  updateLiveNotification();
}

// Elapsed time since the first key time of the current session (ticks live).
function updateSessionTime() {
  const hist = state.server?.history || [];
  if (hist.length) {
    els.statSession.textContent = fmtLongDuration((Date.now() + state.clockOffset) - hist[0].firedAt);
  } else {
    els.statSession.textContent = '—';
  }
}

// While the timer runs, keep ONE persistent notification showing when the next
// key time will hit. The web Notifications API can't render a self-ticking
// countdown — every text "update" is really a re-issue of the notification,
// which is what made it re-pop each minute. So we issue it once per timer start
// (only when the target time changes) and leave it in place; the live ticking
// lives in the app's on-screen countdown.
let liveNotifFireAt = null;
async function updateLiveNotification() {
  if (!('serviceWorker' in navigator) || Notification.permission !== 'granted') return;
  const s = state.server;
  const reg = await navigator.serviceWorker.ready;

  if (s?.running && s.nextFireAt) {
    if (s.nextFireAt === liveNotifFireAt) return; // already showing this one
    liveNotifFireAt = s.nextFireAt;
    const at = new Date(s.nextFireAt).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
    });
    reg.showNotification('Key Time is running ⏳', {
      body: `Next key time at ${at}. Open the app for the live countdown.`,
      tag: 'keytime-countdown',
      silent: true,
      renotify: false,
      requireInteraction: true,
      icon: './icons/icon.svg',
      badge: './icons/icon.svg',
    });
  } else if (liveNotifFireAt !== null) {
    liveNotifFireAt = null;
    const ns = await reg.getNotifications({ tag: 'keytime-countdown' });
    ns.forEach((n) => n.close());
  }
}

// --- Banner --------------------------------------------------------------
function showBanner() {
  els.banner.classList.remove('hidden');
  els.banner.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// --- Settings ------------------------------------------------------------
function readIntervalMs() {
  const v = Math.max(1, parseInt(els.intervalValue.value, 10) || 1);
  const unit = Number(els.intervalUnit.value);
  return v * unit;
}

function fillIntervalInputs(ms) {
  const units = [3600000, 60000];
  for (const u of units) {
    if (ms % u === 0) {
      els.intervalValue.value = String(ms / u);
      els.intervalUnit.value = String(u);
      return;
    }
  }
  els.intervalValue.value = String(Math.round(ms / 60000));
  els.intervalUnit.value = '60000';
}

function formatInterval(ms) {
  const units = [['hour', 3600000], ['minute', 60000]];
  for (const [name, u] of units) {
    if (ms % u === 0) {
      const n = ms / u;
      return `every ${n} ${name}${n !== 1 ? 's' : ''}`;
    }
  }
  const m = Math.round(ms / 60000);
  return `every ${m} minute${m !== 1 ? 's' : ''}`;
}

function updateIntervalSummary() {
  const ms = state.server?.intervalMs || Number(localStorage.getItem(INTERVAL_KEY)) || 3600000;
  els.intervalSummary.textContent = formatInterval(ms);
}

async function saveSettings() {
  const intervalMs = readIntervalMs();
  localStorage.setItem(INTERVAL_KEY, String(intervalMs));
  els.settingsMsg.textContent = 'Saved.';
  if (state.id) {
    const s = await api('/api/settings', 'POST', { id: state.id, intervalMs });
    applyServerState(s);
  }
  updateIntervalSummary();
  setTimeout(() => { els.settingsMsg.textContent = ''; }, 2000);
}

// --- Timer control -------------------------------------------------------
async function startTimer() {
  if (!pushReady()) { await enableNotifications(); if (!pushReady()) return; }
  // make sure server has the latest interval before starting
  await saveSettings();
  const s = await api('/api/start', 'POST', { id: state.id });
  applyServerState(s);
  els.banner.classList.add('hidden');
  // Collapse the interval editor once the timer is running.
  els.intervalEditor.classList.add('hidden');
  els.settingsToggle.classList.remove('open');
  history.replaceState(null, '', './');
}

async function stopTimer() {
  const s = await api('/api/stop', 'POST', { id: state.id });
  applyServerState(s);
}

// Trigger key time early: log it now, stop the timer, and offer to restart.
async function fireNow() {
  const s = await api('/api/fire', 'POST', { id: state.id });
  applyServerState(s);
  showBanner();
}

// Remove a single key time from the current session's history; the list
// re-numbers itself from the refreshed state.
async function removeHistoryEntry(firedAt) {
  if (!state.id) return;
  try {
    const s = await api('/api/history/remove', 'POST', { id: state.id, firedAt });
    applyServerState(s);
  } catch {
    /* ignore */
  }
}

// --- End session: review the summary, name it, save to history, then clear -
function openEndSessionModal() {
  const hist = state.server?.history || [];
  els.esCount.textContent = String(hist.length);
  if (hist.length) {
    const first = hist[0].firedAt;
    const last = hist[hist.length - 1].firedAt;
    const durationMs = last - first;
    els.esDuration.textContent = fmtLongDuration(durationMs);
    els.esAvg.textContent = hist.length > 1
      ? fmtLongDuration(Math.round(durationMs / (hist.length - 1)))
      : '—';
    els.esFirst.textContent = fmtTime(first);
    els.esLast.textContent = fmtTime(last);
  } else {
    els.esDuration.textContent = '—';
    els.esAvg.textContent = '—';
    els.esFirst.textContent = '—';
    els.esLast.textContent = '—';
  }
  els.endsessionDesc.value = '';
  els.endsessionModal.classList.remove('hidden');
  els.endsessionDesc.focus();
}

function closeEndSessionModal() {
  els.endsessionModal.classList.add('hidden');
}

async function confirmEndSession() {
  const description = els.endsessionDesc.value.trim();
  closeEndSessionModal();
  const { state: s } = await api('/api/reset', 'POST', { id: state.id, description });
  applyServerState(s);
  els.banner.classList.add('hidden');
  await refreshSessions();
}

async function refreshSessions() {
  if (!state.token) return;
  try {
    renderSessions((await api('/api/sessions')).sessions);
  } catch {
    /* ignore */
  }
}

async function removeSession(id) {
  if (!confirm('Remove this session from your history?')) return;
  try {
    await api('/api/sessions/remove', 'POST', { sessionId: id });
    await refreshSessions();
  } catch {
    /* ignore */
  }
}

function renderSessions(sessions) {
  els.sessionsList.innerHTML = '';
  els.sessionsEmpty.classList.toggle('hidden', sessions.length > 0);
  sessions.forEach((s) => {
    const li = document.createElement('li');

    const head = document.createElement('div');
    head.className = 's-head';
    const title = document.createElement('span');
    title.className = s.description ? 's-title' : 's-title untitled';
    title.textContent = s.description || 'Untitled session';
    const right = document.createElement('span');
    right.className = 's-head-right';
    const date = document.createElement('span');
    date.className = 's-date';
    date.textContent = fmtTime(s.endedAt);
    const del = document.createElement('button');
    del.className = 'hist-remove';
    del.textContent = '✕';
    del.setAttribute('aria-label', 'Remove this session');
    del.onclick = () => removeSession(s.id);
    right.append(date, del);
    head.append(title, right);

    const stats = document.createElement('div');
    stats.className = 's-stats';
    const dur = fmtLongDuration(s.durationMs);
    const gap = s.avgGapMs != null ? fmtLongDuration(s.avgGapMs) : '—';
    stats.innerHTML = `<b>${s.count}</b> key times · <b>${dur}</b> long · avg gap <b>${gap}</b>`;

    const times = document.createElement('div');
    times.className = 's-stats';
    times.textContent = `first ${fmtTime(s.first)} · last ${fmtTime(s.last)}`;

    li.append(head, stats, times);
    els.sessionsList.append(li);
  });
}

// --- Friends + QR --------------------------------------------------------
function renderQR() {
  if (!state.user || typeof qrcode === 'undefined') return;
  const url = `${location.origin}${location.pathname}?addFriend=${encodeURIComponent(state.user.username)}`;
  const qr = qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  els.qrBox.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 1, scalable: true });
}

async function refreshFriends() {
  if (!state.token) return;
  try {
    renderFriends(await api('/api/friends'));
  } catch {
    /* ignore transient errors */
  }
}

function friendRow(username, tagText, actions) {
  const li = document.createElement('li');
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = username;
  li.append(name);
  if (tagText) {
    const tag = document.createElement('span');
    tag.className = 'gap';
    tag.textContent = tagText;
    li.append(tag);
  }
  if (actions) li.append(actions);
  return li;
}

function renderFriends({ friends, incoming, outgoing }) {
  state.friends = friends;
  els.requestsList.innerHTML = '';
  els.requestsSection.classList.toggle('hidden', incoming.length === 0);
  incoming.forEach((r) => {
    const actions = document.createElement('span');
    actions.className = 'actions';
    const acc = document.createElement('button');
    acc.className = 'btn btn-accept';
    acc.textContent = 'Accept';
    acc.onclick = () => respondFriend(r.friendshipId, true);
    const dec = document.createElement('button');
    dec.className = 'btn btn-decline';
    dec.textContent = 'Decline';
    dec.onclick = () => respondFriend(r.friendshipId, false);
    actions.append(acc, dec);
    els.requestsList.append(friendRow(`👤 ${r.user.username}`, '', actions));
  });

  els.friendsList.innerHTML = '';
  friends.forEach((fr) => {
    const actions = document.createElement('span');
    actions.className = 'actions';
    const invite = document.createElement('button');
    invite.className = 'btn btn-secondary';
    invite.textContent = '🔑 Invite';
    invite.onclick = () => openInviteModal(fr.user.id);
    const remove = document.createElement('button');
    remove.className = 'btn btn-decline';
    remove.textContent = 'Remove';
    remove.onclick = () => removeFriend(fr.user.id, fr.user.username);
    actions.append(invite, remove);
    els.friendsList.append(friendRow(`👤 ${fr.user.username}`, '', actions));
  });
  outgoing.forEach((o) => {
    const actions = document.createElement('span');
    actions.className = 'actions';
    const cancel = document.createElement('button');
    cancel.className = 'btn btn-decline';
    cancel.textContent = 'Cancel';
    cancel.onclick = () => cancelFriendRequest(o.user.id, o.user.username);
    actions.append(cancel);
    els.friendsList.append(friendRow(`👤 ${o.user.username}`, 'requested', actions));
  });
  els.friendsEmpty.classList.toggle('hidden', friends.length + outgoing.length > 0);
}

async function addFriend(username) {
  const name = (username ?? els.friendUsername.value).trim();
  if (!name) return;
  els.friendMsg.textContent = '';
  try {
    const r = await api('/api/friends/request', 'POST', { username: name });
    els.friendUsername.value = '';
    els.friendMsg.textContent =
      r.status === 'accepted'
        ? `You're now friends with ${r.user.username}.`
        : `Request sent to ${r.user.username}.`;
    await refreshFriends();
  } catch (err) {
    els.friendMsg.textContent = err.detail || 'Could not add that user.';
  }
  setTimeout(() => { els.friendMsg.textContent = ''; }, 4000);
}

async function respondFriend(id, accept) {
  try {
    await api('/api/friends/respond', 'POST', { friendshipId: id, accept });
    await refreshFriends();
  } catch {
    /* ignore */
  }
}

async function removeFriend(userId, username) {
  if (!confirm(`Remove ${username} from your friends?`)) return;
  try {
    await api('/api/friends/remove', 'POST', { userId });
    await refreshFriends();
    await refreshInvites();
  } catch {
    els.friendMsg.textContent = 'Could not remove that friend.';
    setTimeout(() => { els.friendMsg.textContent = ''; }, 4000);
  }
}

async function cancelFriendRequest(userId, username) {
  if (!confirm(`Cancel your friend request to ${username}?`)) return;
  try {
    await api('/api/friends/remove', 'POST', { userId });
    await refreshFriends();
  } catch {
    els.friendMsg.textContent = 'Could not cancel that request.';
    setTimeout(() => { els.friendMsg.textContent = ''; }, 4000);
  }
}

// --- Invites -------------------------------------------------------------
async function refreshInvites() {
  if (!state.token) return;
  try {
    renderInvites(await api('/api/invites'));
  } catch {
    /* ignore transient errors */
  }
}

function inviteItem(inv, { incoming }) {
  const li = document.createElement('li');
  li.className = 'invite-item';
  const isGroup = !!inv.group;

  const head = document.createElement('div');
  head.className = 'invite-head';
  const name = document.createElement('span');
  name.className = 'name';
  // For a group key time the group is the subject, flagged with a 👥 emoji;
  // who sent it goes in the context line below. 1:1 invites show the person
  // with a single-person 👤 emoji.
  name.textContent = isGroup ? `👥 ${inv.group.name}` : `👤 ${inv.user.username}`;

  const right = document.createElement('span');
  right.className = 'invite-head-right';
  // The collapsed outgoing-group row has no single meaningful status — the
  // X/Y counter conveys it instead.
  if (!(isGroup && !incoming)) {
    const status = document.createElement('span');
    status.className = `invite-status ${inv.status}`;
    status.textContent = inv.status;
    right.append(status);
  }

  head.append(name, right);
  li.append(head);

  // Dismiss sits in the top-right corner of the card (not inline by the name).
  const dismiss = document.createElement('button');
  dismiss.className = 'invite-dismiss';
  dismiss.textContent = '✕';
  dismiss.setAttribute('aria-label', 'Dismiss');
  dismiss.onclick = () => (isGroup ? dismissEvent(inv.event.id) : dismissInvite(inv.id));
  li.append(dismiss);

  // Group context: who sent it (for incoming invites).
  if (isGroup && incoming) {
    const ctx = document.createElement('div');
    ctx.className = 'invite-group';
    const from = document.createElement('span');
    from.className = 'invite-from';
    from.textContent = `from ${inv.user.username}`;
    ctx.append(from);
    li.append(ctx);
  }

  if (inv.message) {
    const note = document.createElement('div');
    note.className = 'invite-note';
    note.textContent = `“${inv.message}”`;
    li.append(note);
  }

  const times = document.createElement('div');
  times.className = 'invite-times';
  const sent = document.createElement('div');
  sent.textContent = `sent ${fmtTime(inv.createdAt)}`;
  times.append(sent);
  // Per-person responded line on its own row, so a long name doesn't crowd the
  // "sent" timestamp. Skipped for collapsed outgoing group rows.
  if (inv.respondedAt && (!isGroup || incoming)) {
    const who = inv.respondedBy && inv.respondedBy === state.user?.id ? 'you' : inv.user.username;
    const resp = document.createElement('div');
    resp.textContent = `${who} ${inv.status} · ${fmtTime(inv.respondedAt)}`;
    times.append(resp);
  }
  li.append(times);

  // Group key-time aggregate: "X/Y in" + a collapsible per-member breakdown.
  if (isGroup && inv.event) {
    const row = document.createElement('div');
    row.className = 'event-row';
    const count = document.createElement('span');
    count.className = 'event-count';
    count.textContent = `${inv.event.accepted}/${inv.event.total} in`;
    const toggle = document.createElement('button');
    toggle.className = 'event-toggle';
    toggle.textContent = 'Show responses';
    const responses = document.createElement('div');
    responses.className = 'event-responses hidden';
    toggle.onclick = async () => {
      if (!responses.classList.contains('hidden')) {
        responses.classList.add('hidden');
        toggle.textContent = 'Show responses';
        return;
      }
      if (!responses.dataset.loaded) {
        try {
          const data = await api(`/api/event?eventId=${encodeURIComponent(inv.event.id)}`);
          responses.innerHTML = '';
          data.members.forEach((m) => {
            const r = document.createElement('div');
            r.className = 'event-member';
            const n = document.createElement('span');
            n.textContent = `👤 ${m.user.username}`;
            const s = document.createElement('span');
            s.className = `invite-status ${m.status}`;
            s.textContent = m.status;
            r.append(n, s);
            responses.append(r);
          });
          responses.dataset.loaded = '1';
        } catch {
          responses.textContent = 'Could not load responses.';
        }
      }
      responses.classList.remove('hidden');
      toggle.textContent = 'Hide responses';
    };
    row.append(count, toggle);
    li.append(row, responses);
  }

  // A small helper for the response buttons.
  const mkBtn = (cls, label, accept) => {
    const b = document.createElement('button');
    b.className = `btn ${cls}`;
    b.textContent = label;
    b.onclick = () => respondInvite(inv.id, accept);
    return b;
  };

  // Action buttons.
  const actions = document.createElement('div');
  actions.className = 'actions';
  if (incoming) {
    if (isGroup) {
      // Group recipient can flip their RSVP at any time without it disappearing.
      if (inv.status === 'accepted') {
        actions.append(mkBtn('btn-decline', 'Drop out', false));
      } else if (inv.status === 'declined') {
        actions.append(mkBtn('btn-accept', "I'm back in", true));
      } else {
        actions.append(mkBtn('btn-accept', "I'm in", true));
        actions.append(mkBtn('btn-decline', 'Decline', false));
      }
    } else if (inv.status !== 'declined') {
      // 1:1 recipient: accept (unless already in) and/or decline.
      if (inv.status !== 'accepted') actions.append(mkBtn('btn-accept', "I'm in", true));
      actions.append(mkBtn('btn-decline', 'Decline', false));
    }
  } else if (isGroup) {
    // Initiator of a group blast can drop out (or rejoin) without cancelling the
    // key time for everyone else; the whole blast is cleared via the ✕ instead.
    if (inv.event?.myInviteId) {
      const inGroup = inv.event.myStatus === 'accepted';
      const toggle = document.createElement('button');
      toggle.className = inGroup ? 'btn btn-decline' : 'btn btn-accept';
      toggle.textContent = inGroup ? 'Drop out' : "I'm back in";
      toggle.onclick = () => respondInvite(inv.event.myInviteId, !inGroup);
      actions.append(toggle);
    }
  } else if (inv.status !== 'declined') {
    // Sender of a 1:1 invite can cancel.
    const cancel = document.createElement('button');
    cancel.className = 'btn btn-decline';
    cancel.textContent = 'Cancel';
    cancel.onclick = () => respondInvite(inv.id, false);
    actions.append(cancel);
  }
  if (actions.children.length) li.append(actions);

  return li;
}

function renderInvites({ incoming, outgoing }) {
  els.invitesIncoming.innerHTML = '';
  els.invitesIncomingSection.classList.toggle('hidden', incoming.length === 0);
  incoming.forEach((inv) => els.invitesIncoming.append(inviteItem(inv, { incoming: true })));

  els.invitesOutgoing.innerHTML = '';
  els.invitesOutgoingSection.classList.toggle('hidden', outgoing.length === 0);
  outgoing.forEach((inv) => els.invitesOutgoing.append(inviteItem(inv, { incoming: false })));

  els.invitesEmpty.classList.toggle('hidden', incoming.length + outgoing.length > 0);
  // Whole card only appears when there's something to show.
  els.invitesCard.classList.toggle('hidden', incoming.length + outgoing.length === 0);
}

// --- Invite compose modal ------------------------------------------------
// Opens the picker with `userId` pre-checked, but you can tick more friends to
// send the same note to several at once.
function openInviteModal(userId) {
  els.inviteFriends.innerHTML = '';
  (state.friends || []).forEach((fr) => {
    const label = document.createElement('label');
    label.className = 'invite-pick';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = fr.user.id;
    cb.dataset.username = fr.user.username;
    if (fr.user.id === userId) cb.checked = true;
    const span = document.createElement('span');
    span.textContent = fr.user.username;
    label.append(cb, span);
    els.inviteFriends.append(label);
  });
  els.inviteModalTitle.textContent = 'Invite to key time';
  els.inviteMessage.value = '';
  els.inviteModal.classList.remove('hidden');
  els.inviteMessage.focus();
}

function closeInviteModal() {
  els.inviteModal.classList.add('hidden');
}

async function sendInvite() {
  const targets = [...els.inviteFriends.querySelectorAll('input:checked')].map((c) => ({
    id: c.value,
    username: c.dataset.username,
  }));
  if (!targets.length) return;
  const message = els.inviteMessage.value.trim();
  closeInviteModal();
  els.friendMsg.textContent = '';

  let sent = 0;
  const failed = [];
  for (const t of targets) {
    try {
      await api('/api/invite', 'POST', { toUserId: t.id, message });
      sent++;
    } catch {
      failed.push(t.username);
    }
  }

  if (failed.length) {
    els.friendMsg.textContent = `Sent ${sent}; couldn't invite ${failed.join(', ')}.`;
  } else if (sent === 1) {
    els.friendMsg.textContent = `Key time invite sent to ${targets[0].username}.`;
  } else {
    els.friendMsg.textContent = `Key time invite sent to ${sent} friends.`;
  }
  await refreshInvites();
  setTimeout(() => { els.friendMsg.textContent = ''; }, 4000);
}

async function respondInvite(id, accept) {
  try {
    await api('/api/invite/respond', 'POST', { inviteId: id, accept });
    await refreshInvites();
  } catch {
    /* ignore */
  }
}

async function dismissInvite(id) {
  try {
    await api('/api/invite/dismiss', 'POST', { inviteId: id });
    await refreshInvites();
  } catch {
    /* ignore */
  }
}

// Clear a whole group blast (all invites sharing one eventId) from my list.
async function dismissEvent(eventId) {
  try {
    await api('/api/invite/dismiss', 'POST', { eventId });
    await refreshInvites();
  } catch {
    /* ignore */
  }
}

// --- Groups --------------------------------------------------------------
async function refreshGroups() {
  if (!state.token) return;
  try {
    renderGroups(await api('/api/groups'));
  } catch {
    /* ignore transient errors */
  }
}

function renderGroups({ groups, invites }) {
  state.groups = groups;

  // Pending invitations to join a group.
  els.groupInvites.innerHTML = '';
  els.groupInvitesSection.classList.toggle('hidden', invites.length === 0);
  invites.forEach((inv) => {
    const actions = document.createElement('span');
    actions.className = 'actions';
    const acc = document.createElement('button');
    acc.className = 'btn btn-accept';
    acc.textContent = 'Join';
    acc.onclick = () => respondGroupInvite(inv.groupInviteId, true);
    const dec = document.createElement('button');
    dec.className = 'btn btn-decline';
    dec.textContent = 'Decline';
    dec.onclick = () => respondGroupInvite(inv.groupInviteId, false);
    actions.append(acc, dec);
    els.groupInvites.append(
      friendRow(`👥 ${inv.group.name} · from ${inv.user.username}`, '', actions)
    );
  });

  // Groups I'm in.
  const myFriendIds = new Set((state.friends || []).map((f) => f.user.id));
  els.groupsList.innerHTML = '';
  els.groupsEmpty.classList.toggle('hidden', groups.length > 0);
  groups.forEach((g) => {
    const li = document.createElement('li');
    li.className = 'group';

    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.className = 'group-summary';
    const title = document.createElement('span');
    title.className = 'group-name';
    title.textContent = `👥 ${g.name}`;
    const right = document.createElement('span');
    right.className = 'group-summary-right';
    const count = document.createElement('span');
    count.className = 'group-count';
    count.textContent = `${g.members.length} ${g.members.length === 1 ? 'member' : 'members'}`;
    // The key-time invite lives on the summary line (like the friend rows), so it
    // works without expanding the group. Stop the click from toggling the panel.
    const kt = document.createElement('button');
    kt.className = 'btn btn-secondary group-invite-btn';
    kt.textContent = '🔑 Invite';
    kt.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      openGroupKeytimeModal(g.id, g.name);
    };
    right.append(count, kt);
    summary.append(title, right);
    details.append(summary);

    // Member list — non-friends (and not me) get an Add button.
    const memberUl = document.createElement('ul');
    memberUl.className = 'group-members';
    g.members.forEach((m) => {
      const isMe = m.id === state.user?.id;
      let actions = null;
      if (!isMe) {
        actions = document.createElement('span');
        actions.className = 'actions';
        if (!myFriendIds.has(m.id)) {
          const add = document.createElement('button');
          add.className = 'btn btn-secondary';
          add.textContent = 'Add friend';
          add.onclick = () => addFriend(m.username);
          actions.append(add);
        }
        // The creator can remove anyone; a member can remove only those they added.
        const iAddedThem = (g.invitedBy || {})[m.id] === state.user?.id;
        if (g.isOwner || iAddedThem) {
          const kick = document.createElement('button');
          kick.className = 'btn btn-decline';
          kick.textContent = 'Remove';
          kick.onclick = () => kickMember(g.id, m.id, m.username);
          actions.append(kick);
        }
        if (!actions.children.length) actions = null;
      }
      const label = isMe ? `👤 ${m.username} (you)` : `👤 ${m.username}`;
      memberUl.append(friendRow(label, '', actions));
    });
    details.append(memberUl);

    // Group actions (the key-time invite now lives on the summary line above).
    const actions = document.createElement('div');
    actions.className = 'group-actions';
    const addFr = document.createElement('button');
    addFr.className = 'btn btn-secondary';
    addFr.textContent = 'Add friends';
    addFr.onclick = () => openGroupInviteModal(g.id, g.name);
    actions.append(addFr);
    if (g.isOwner) {
      const del = document.createElement('button');
      del.className = 'btn btn-decline';
      del.textContent = 'Delete';
      del.onclick = () => deleteGroup(g.id, g.name);
      actions.append(del);
    } else {
      const leave = document.createElement('button');
      leave.className = 'btn btn-decline';
      leave.textContent = 'Leave';
      leave.onclick = () => leaveGroup(g.id, g.name);
      actions.append(leave);
    }
    details.append(actions);

    li.append(details);
    els.groupsList.append(li);
  });
}

async function createGroup() {
  const name = els.groupName.value.trim();
  if (!name) return;
  els.groupMsg.textContent = '';
  // A group needs people — add at least one friend before creating one.
  if (!(state.friends || []).length) {
    els.groupMsg.textContent = 'Add a friend first — you choose who to add when you create a group.';
    setTimeout(() => { els.groupMsg.textContent = ''; }, 5000);
    return;
  }
  try {
    const g = await api('/api/groups', 'POST', { name });
    els.groupName.value = '';
    els.groupMsg.textContent = `Group "${g.name}" created.`;
    await refreshGroups();
    // Jump straight into picking who to add.
    openGroupInviteModal(g.id, g.name);
  } catch (err) {
    els.groupMsg.textContent = err.detail || 'Could not create group.';
  }
  setTimeout(() => { els.groupMsg.textContent = ''; }, 4000);
}

async function respondGroupInvite(groupInviteId, accept) {
  try {
    await api('/api/groups/respond', 'POST', { groupInviteId, accept });
    await refreshGroups();
  } catch {
    /* ignore */
  }
}

async function kickMember(groupId, userId, username) {
  if (!confirm(`Remove ${username} from this group?`)) return;
  try {
    await api('/api/groups/kick', 'POST', { groupId, userId });
    await refreshGroups();
  } catch (err) {
    els.groupMsg.textContent = err.detail || 'Could not remove that member.';
    setTimeout(() => { els.groupMsg.textContent = ''; }, 4000);
  }
}

async function leaveGroup(groupId, name) {
  if (!confirm(`Leave "${name}"?`)) return;
  try {
    await api('/api/groups/leave', 'POST', { groupId });
    await refreshGroups();
  } catch (err) {
    els.groupMsg.textContent = err.detail || 'Could not leave group.';
    setTimeout(() => { els.groupMsg.textContent = ''; }, 4000);
  }
}

async function deleteGroup(groupId, name) {
  if (!confirm(`Delete "${name}" for everyone?`)) return;
  try {
    await api('/api/groups/delete', 'POST', { groupId });
    await refreshGroups();
  } catch (err) {
    els.groupMsg.textContent = err.detail || 'Could not delete group.';
    setTimeout(() => { els.groupMsg.textContent = ''; }, 4000);
  }
}

// Invite friends into a group (pills picker; only friends not already in it).
function openGroupInviteModal(groupId, name) {
  state.groupTarget = groupId;
  const group = state.groups.find((g) => g.id === groupId);
  const memberIds = new Set(group ? group.members.map((m) => m.id) : []);
  const candidates = (state.friends || []).filter((f) => !memberIds.has(f.user.id));
  els.groupInviteTitle.textContent = `Add friends to "${name}"`;
  els.groupInviteFriends.innerHTML = '';
  candidates.forEach((fr) => {
    const label = document.createElement('label');
    label.className = 'invite-pick';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = fr.user.id;
    cb.dataset.username = fr.user.username;
    const span = document.createElement('span');
    span.textContent = fr.user.username;
    label.append(cb, span);
    els.groupInviteFriends.append(label);
  });
  els.groupInviteEmpty.textContent = (state.friends || []).length
    ? 'All your friends are already in this group.'
    : 'Add some friends first, then add them here.';
  els.groupInviteEmpty.classList.toggle('hidden', candidates.length > 0);
  els.groupInviteModal.classList.remove('hidden');
}

function closeGroupInviteModal() {
  els.groupInviteModal.classList.add('hidden');
  state.groupTarget = null;
}

async function sendGroupInvite() {
  const groupId = state.groupTarget;
  const targets = [...els.groupInviteFriends.querySelectorAll('input:checked')].map((c) => ({
    id: c.value,
    username: c.dataset.username,
  }));
  closeGroupInviteModal();
  if (!groupId || !targets.length) return;
  let sent = 0;
  const failed = [];
  for (const t of targets) {
    try {
      await api('/api/groups/invite', 'POST', { groupId, userId: t.id });
      sent++;
    } catch {
      failed.push(t.username);
    }
  }
  els.groupMsg.textContent = failed.length
    ? `Added ${sent}; couldn't add ${failed.join(', ')}.`
    : `Added ${sent} ${sent === 1 ? 'friend' : 'friends'} to the group.`;
  await refreshGroups();
  setTimeout(() => { els.groupMsg.textContent = ''; }, 4000);
}

function openGroupKeytimeModal(groupId, name) {
  state.groupTarget = groupId;
  els.groupKeytimeTitle.textContent = `Invite "${name}" to key time`;
  els.groupKeytimeMessage.value = '';
  els.groupKeytimeModal.classList.remove('hidden');
  els.groupKeytimeMessage.focus();
}

function closeGroupKeytimeModal() {
  els.groupKeytimeModal.classList.add('hidden');
  state.groupTarget = null;
}

async function sendGroupKeytime() {
  const groupId = state.groupTarget;
  const message = els.groupKeytimeMessage.value.trim();
  closeGroupKeytimeModal();
  if (!groupId) return;
  els.groupMsg.textContent = '';
  try {
    const r = await api('/api/groups/keytime', 'POST', { groupId, message });
    els.groupMsg.textContent = `Key time invite sent to ${r.sent} ${r.sent === 1 ? 'person' : 'people'}.`;
    await refreshInvites();
  } catch (err) {
    els.groupMsg.textContent = err.detail || 'Could not invite the group.';
  }
  setTimeout(() => { els.groupMsg.textContent = ''; }, 4000);
}

// --- Polling -------------------------------------------------------------
async function refreshState() {
  if (!state.id) return;
  try {
    const s = await api(`/api/state?id=${encodeURIComponent(state.id)}`);
    applyServerState(s);
    els.connStatus.textContent = 'synced';
  } catch (err) {
    if (String(err).includes('404')) {
      // record vanished server-side — re-subscribe
      localStorage.removeItem(ID_KEY);
      state.id = null;
      await ensureSubscription();
    } else {
      els.connStatus.textContent = 'offline';
    }
  }
}

// --- Auth (username + password) ------------------------------------------
function setAuthMode(mode) {
  state.authMode = mode;
  const register = mode === 'register';
  els.authTitle.textContent = register ? 'Welcome to Key Time' : 'Welcome back';
  els.authSub.textContent = register
    ? 'Create an account — your username is how friends find you, and it works on any device.'
    : 'Log in to pick up where you left off.';
  els.authSubmit.textContent = register ? 'Create account' : 'Log in';
  els.authPassword.autocomplete = register ? 'new-password' : 'current-password';
  els.authSwitchText.textContent = register ? 'Already have an account?' : 'New here?';
  els.authSwitch.textContent = register ? 'Log in' : 'Create account';
  els.authMsg.textContent = '';
}

function showAuth() {
  els.authScreen.classList.remove('hidden');
  els.appBody.classList.add('hidden');
  els.accountBar.classList.add('hidden');
  els.header.classList.add('hidden'); // welcome card carries the branding
}

function showApp() {
  els.authScreen.classList.add('hidden');
  els.appBody.classList.remove('hidden');
  els.accountBar.classList.remove('hidden');
  els.header.classList.remove('hidden');
  els.accountName.textContent = state.user?.username || '';
}

async function doAuth(e) {
  e.preventDefault();
  const username = els.authUsername.value.trim();
  const password = els.authPassword.value;
  els.authMsg.textContent = '';
  els.authSubmit.disabled = true;
  try {
    const path = state.authMode === 'register' ? '/api/register' : '/api/login';
    const { token, user, createdAt } = await api(path, 'POST', { username, password });
    state.token = token;
    state.user = user;
    state.accountCreatedAt = createdAt || null;
    state.hasPassword = true;
    localStorage.setItem(TOKEN_KEY, token);
    showApp();
    await startApp();
  } catch (err) {
    els.authMsg.textContent = err.detail || 'Something went wrong. Try again.';
  } finally {
    els.authSubmit.disabled = false;
  }
}

function logout() {
  if (!confirm('Log out of Key Time on this device?')) return;
  localStorage.removeItem(TOKEN_KEY);
  state.token = null;
  state.user = null;
  location.reload();
}

async function saveUsername() {
  const username = els.nameInput.value.trim();
  els.nameMsg.textContent = '';
  if (!username || username === state.user?.username) return;
  try {
    const { user } = await api('/api/username', 'POST', { username });
    state.user = user;
    els.accountName.textContent = user.username;
    els.nameInput.value = user.username;
    renderQR(); // QR encodes the username
    els.nameMsg.textContent = 'Username updated.';
    await refreshFriends();
  } catch (err) {
    els.nameMsg.textContent = err.detail || 'Could not update username.';
  }
  setTimeout(() => { els.nameMsg.textContent = ''; }, 3000);
}

function renderAccountCreated() {
  if (!els.accountCreated) return;
  if (state.accountCreatedAt) {
    const d = new Date(state.accountCreatedAt).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
    els.accountCreated.textContent = `Account created on ${d}.`;
  } else {
    els.accountCreated.textContent = '';
  }
}

function renderPasswordSection() {
  els.pwHeading.textContent = 'Password';
  els.pwSave.textContent = 'Update';
  els.pwInput.placeholder = 'new password';
  els.pwHint.textContent = state.hasPassword
    ? 'Update the password you use to log in.'
    : 'Set a password so you can log in on another device.';
}

async function savePassword() {
  const password = els.pwInput.value;
  els.pwMsg.textContent = '';
  if (!password || password.length < 6) {
    els.pwMsg.textContent = 'Password must be at least 6 characters.';
    return;
  }
  try {
    await api('/api/password', 'POST', { password });
    state.hasPassword = true;
    els.pwInput.value = '';
    els.pwMsg.textContent = 'Password saved.';
    renderPasswordSection();
  } catch (err) {
    els.pwMsg.textContent = err.detail || 'Could not save password.';
  }
  setTimeout(() => { els.pwMsg.textContent = ''; }, 3000);
}

// --- Tabs ----------------------------------------------------------------
function showTab(name) {
  document.querySelectorAll('[data-panel]').forEach((el) =>
    el.classList.toggle('hidden', el.dataset.panel !== name)
  );
  document.querySelectorAll('.tab').forEach((t) =>
    t.classList.toggle('active', t.dataset.tab === name)
  );
}

// Sub-tabs within the Peeps card: Friends vs Groups (one visible at a time).
function showSubTab(name) {
  document.querySelectorAll('[data-subpanel]').forEach((el) =>
    el.classList.toggle('hidden', el.dataset.subpanel !== name)
  );
  document.querySelectorAll('.subtab').forEach((t) =>
    t.classList.toggle('active', t.dataset.subtab === name)
  );
}

// --- Init ----------------------------------------------------------------
async function startApp() {
  if (state.started) return;
  state.started = true;

  const params = new URLSearchParams(location.search);
  if (params.get('keytime') === '1') showBanner();

  renderPasswordSection();
  renderAccountCreated();
  els.nameInput.value = state.user?.username || '';
  await ensureSubscription();
  await refreshState();
  renderQR();
  await refreshFriends();
  await refreshGroups();
  await refreshInvites();
  await refreshSessions();
  render();

  // Deep links: ?addFriend=<username> (scanned QR), ?friends=1, ?invites=1.
  const pendingFriend = params.get('addFriend');
  if (pendingFriend && pendingFriend !== state.user?.username) {
    await addFriend(pendingFriend);
  }
  if (pendingFriend || params.get('friends') === '1') {
    showTab('friends');
    els.friendsCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  if (params.get('invites') === '1') {
    els.invitesCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  if (pendingFriend || params.get('friends') || params.get('invites')) {
    history.replaceState(null, '', './');
  }

  // sync from server periodically; tick the countdown every second
  setInterval(refreshState, 10000);
  setInterval(() => { refreshFriends(); refreshGroups(); refreshInvites(); }, 15000);
  setInterval(updateCountdown, 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      refreshState();
      refreshFriends();
      refreshGroups();
      refreshInvites();
    }
  });
}

async function init() {
  els.startBtn.addEventListener('click', startTimer);
  els.fireBtn.addEventListener('click', fireNow);
  els.stopBtn.addEventListener('click', stopTimer);
  els.resetBtn.addEventListener('click', openEndSessionModal);
  els.endsessionConfirm.addEventListener('click', confirmEndSession);
  els.endsessionCancel.addEventListener('click', closeEndSessionModal);
  els.endsessionModal.addEventListener('click', (e) => {
    if (e.target === els.endsessionModal) closeEndSessionModal();
  });
  els.bannerStart.addEventListener('click', startTimer);
  els.saveSettings.addEventListener('click', saveSettings);
  els.settingsToggle.addEventListener('click', () => {
    const hidden = els.intervalEditor.classList.toggle('hidden');
    els.settingsToggle.classList.toggle('open', !hidden);
  });
  els.enableBtn?.addEventListener('click', enableNotifications);
  els.authForm.addEventListener('submit', doAuth);
  els.authSwitch.addEventListener('click', () =>
    setAuthMode(state.authMode === 'register' ? 'login' : 'register')
  );
  els.logoutBtn.addEventListener('click', logout);
  els.nameSave.addEventListener('click', saveUsername);
  els.pwSave.addEventListener('click', savePassword);
  els.friendAddBtn.addEventListener('click', () => addFriend());
  els.friendUsername.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addFriend();
  });
  els.inviteSend.addEventListener('click', sendInvite);
  els.inviteCancel.addEventListener('click', closeInviteModal);
  els.inviteMessage.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendInvite();
  });
  els.inviteModal.addEventListener('click', (e) => {
    if (e.target === els.inviteModal) closeInviteModal();
  });

  // Groups
  els.groupCreateBtn.addEventListener('click', createGroup);
  els.groupName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') createGroup();
  });
  els.groupKeytimeSend.addEventListener('click', sendGroupKeytime);
  els.groupKeytimeCancel.addEventListener('click', closeGroupKeytimeModal);
  els.groupKeytimeMessage.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendGroupKeytime();
  });
  els.groupKeytimeModal.addEventListener('click', (e) => {
    if (e.target === els.groupKeytimeModal) closeGroupKeytimeModal();
  });
  els.groupInviteSend.addEventListener('click', sendGroupInvite);
  els.groupInviteCancel.addEventListener('click', closeGroupInviteModal);
  els.groupInviteModal.addEventListener('click', (e) => {
    if (e.target === els.groupInviteModal) closeGroupInviteModal();
  });

  // Tab menu
  els.tabs.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => showTab(tab.dataset.tab));
  });
  showTab('timer');

  // Peeps sub-tabs (Friends / Groups)
  document.querySelectorAll('#peeps-subtabs .subtab').forEach((tab) => {
    tab.addEventListener('click', () => showSubTab(tab.dataset.subtab));
  });
  showSubTab('friends');

  // restore saved interval into the form
  const savedInterval = Number(localStorage.getItem(INTERVAL_KEY));
  if (savedInterval) fillIntervalInputs(savedInterval);

  await registerSW();
  try {
    state.config = await api('/api/config');
  } catch {
    els.connStatus.textContent = 'server offline';
  }

  // Gate on auth: a stored token must still be valid.
  if (state.token) {
    try {
      const { user, hasPassword, createdAt } = await api('/api/me');
      state.user = user;
      state.accountCreatedAt = createdAt || null;
      state.hasPassword = Boolean(hasPassword);
      renderPasswordSection();
      showApp();
      await startApp();
      return;
    } catch {
      localStorage.removeItem(TOKEN_KEY);
      state.token = null;
    }
  }
  setAuthMode('register');
  showAuth();
}

init();
