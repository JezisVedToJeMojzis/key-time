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
  statCount: $('stat-count'),
  statSession: $('stat-session'),
  statAvg: $('stat-avg'),
  statFirst: $('stat-first'),
  statLast: $('stat-last'),
  historyList: $('history-list'),
  historyEmpty: $('history-empty'),
  resetBtn: $('reset-btn'),
  reportCard: $('report-card'),
  repCount: $('rep-count'),
  repDuration: $('rep-duration'),
  repAvg: $('rep-avg'),
  repRange: $('rep-range'),
  reportDone: $('report-done'),
  connStatus: $('conn-status'),
  authScreen: $('auth-screen'),
  authForm: $('auth-form'),
  authUsername: $('auth-username'),
  authSubmit: $('auth-submit'),
  authMsg: $('auth-msg'),
  header: document.querySelector('.header'),
  appBody: $('app-body'),
  accountBar: $('account-bar'),
  accountName: $('account-name'),
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
};

const ID_KEY = 'keytime.id';
const INTERVAL_KEY = 'keytime.intervalMs';
const TOKEN_KEY = 'keytime.token';

const state = {
  id: localStorage.getItem(ID_KEY) || null,
  token: localStorage.getItem(TOKEN_KEY) || null,
  user: null,
  config: null,
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
    right.className = 'gap';
    const realIdx = idxFromStart - 1;
    if (realIdx > 0) right.textContent = fmtGap(h.firedAt - hist[realIdx - 1].firedAt);
    else right.textContent = 'first';
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
  const units = [86400000, 3600000, 60000];
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

async function saveSettings() {
  const intervalMs = readIntervalMs();
  localStorage.setItem(INTERVAL_KEY, String(intervalMs));
  els.settingsMsg.textContent = 'Saved.';
  if (state.id) {
    const s = await api('/api/settings', 'POST', { id: state.id, intervalMs });
    applyServerState(s);
  }
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

// --- End session: show report, then clear everything ---------------------
async function resetSession() {
  if (!confirm('End this key-time session? You\'ll see a report, then the timer and all statistics are cleared.')) {
    return;
  }
  const { report, state: s } = await api('/api/reset', 'POST', { id: state.id });
  applyServerState(s);
  showReport(report);
  els.banner.classList.add('hidden');
}

function showReport(report) {
  els.repCount.textContent = String(report.count || 0);
  if (report.count > 0) {
    els.repDuration.textContent = fmtLongDuration(report.durationMs);
    els.repAvg.textContent = report.count > 1 ? fmtLongDuration(report.avgGapMs) : '—';
    els.repRange.textContent = `First: ${fmtTime(report.first)}  ·  Last: ${fmtTime(report.last)}`;
  } else {
    els.repDuration.textContent = '—';
    els.repAvg.textContent = '—';
    els.repRange.textContent = 'No key times were recorded this session.';
  }
  els.reportCard.classList.remove('hidden');
  els.reportCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
    els.requestsList.append(friendRow(r.user.username, '', actions));
  });

  els.friendsList.innerHTML = '';
  friends.forEach((fr) => {
    const actions = document.createElement('span');
    actions.className = 'actions';
    const invite = document.createElement('button');
    invite.className = 'btn btn-secondary';
    invite.textContent = '🔑 Invite';
    invite.onclick = () => sendInvite(fr.user.id, fr.user.username);
    actions.append(invite);
    els.friendsList.append(friendRow(fr.user.username, '', actions));
  });
  outgoing.forEach((o) => els.friendsList.append(friendRow(o.user.username, 'requested')));
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

// --- Invites -------------------------------------------------------------
async function refreshInvites() {
  if (!state.token) return;
  try {
    renderInvites(await api('/api/invites'));
  } catch {
    /* ignore transient errors */
  }
}

const INVITE_STATUS = { pending: 'waiting…', accepted: 'accepted ✓', declined: 'declined' };

function renderInvites({ incoming, outgoing }) {
  els.invitesIncoming.innerHTML = '';
  els.invitesIncomingSection.classList.toggle('hidden', incoming.length === 0);
  incoming.forEach((inv) => {
    const actions = document.createElement('span');
    actions.className = 'actions';
    const acc = document.createElement('button');
    acc.className = 'btn btn-accept';
    acc.textContent = "I'm in";
    acc.onclick = () => respondInvite(inv.id, true);
    const dec = document.createElement('button');
    dec.className = 'btn btn-decline';
    dec.textContent = 'Decline';
    dec.onclick = () => respondInvite(inv.id, false);
    actions.append(acc, dec);
    els.invitesIncoming.append(friendRow(inv.user.username, '', actions));
  });

  els.invitesOutgoing.innerHTML = '';
  els.invitesOutgoingSection.classList.toggle('hidden', outgoing.length === 0);
  outgoing.forEach((inv) => {
    const actions = document.createElement('span');
    actions.className = 'actions';
    const dismiss = document.createElement('button');
    dismiss.className = 'btn btn-decline';
    dismiss.textContent = '✕';
    dismiss.setAttribute('aria-label', 'Dismiss');
    dismiss.onclick = () => dismissInvite(inv.id);
    actions.append(dismiss);
    els.invitesOutgoing.append(
      friendRow(inv.user.username, INVITE_STATUS[inv.status] || inv.status, actions)
    );
  });

  els.invitesEmpty.classList.toggle('hidden', incoming.length + outgoing.length > 0);
  // Whole card only appears when there's something to show.
  els.invitesCard.classList.toggle('hidden', incoming.length + outgoing.length === 0);
}

async function sendInvite(userId, username) {
  els.friendMsg.textContent = '';
  try {
    await api('/api/invite', 'POST', { toUserId: userId });
    els.friendMsg.textContent = `Key time invite sent to ${username}.`;
    await refreshInvites();
  } catch (err) {
    els.friendMsg.textContent = err.detail || 'Could not send invite.';
  }
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

// --- Auth (pick a username; bound to this device) ------------------------
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

async function claimUsername(e) {
  e.preventDefault();
  const username = els.authUsername.value.trim();
  els.authMsg.textContent = '';
  els.authSubmit.disabled = true;
  try {
    const { token, user } = await api('/api/register', 'POST', { username });
    state.token = token;
    state.user = user;
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
  if (!confirm('Log out? This username is tied to this device — without it you may not be able to reclaim the name.')) return;
  localStorage.removeItem(TOKEN_KEY);
  state.token = null;
  state.user = null;
  location.reload();
}

// --- Init ----------------------------------------------------------------
async function startApp() {
  if (state.started) return;
  state.started = true;

  const params = new URLSearchParams(location.search);
  if (params.get('keytime') === '1') showBanner();

  await ensureSubscription();
  await refreshState();
  renderQR();
  await refreshFriends();
  await refreshInvites();
  render();

  // Deep links: ?addFriend=<username> (scanned QR), ?friends=1, ?invites=1.
  const pendingFriend = params.get('addFriend');
  if (pendingFriend && pendingFriend !== state.user?.username) {
    await addFriend(pendingFriend);
  }
  if (pendingFriend || params.get('friends') === '1') {
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
  setInterval(() => { refreshFriends(); refreshInvites(); }, 15000);
  setInterval(updateCountdown, 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      refreshState();
      refreshFriends();
      refreshInvites();
    }
  });
}

async function init() {
  els.startBtn.addEventListener('click', startTimer);
  els.fireBtn.addEventListener('click', fireNow);
  els.stopBtn.addEventListener('click', stopTimer);
  els.resetBtn.addEventListener('click', resetSession);
  els.reportDone.addEventListener('click', () => els.reportCard.classList.add('hidden'));
  els.bannerStart.addEventListener('click', startTimer);
  els.saveSettings.addEventListener('click', saveSettings);
  els.enableBtn?.addEventListener('click', enableNotifications);
  els.authForm.addEventListener('submit', claimUsername);
  els.logoutBtn.addEventListener('click', logout);
  els.friendAddBtn.addEventListener('click', () => addFriend());
  els.friendUsername.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addFriend();
  });

  // Collapsible cards (Settings, Friends) — remember state per card.
  document.querySelectorAll('.card-collapsible').forEach((card) => {
    const key = `keytime.collapse.${card.id}`;
    if (localStorage.getItem(key) === '1') card.classList.add('collapsed');
    card.querySelector('h2').addEventListener('click', () => {
      const collapsed = card.classList.toggle('collapsed');
      localStorage.setItem(key, collapsed ? '1' : '0');
    });
  });

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
      const { user } = await api('/api/me');
      state.user = user;
      showApp();
      await startApp();
      return;
    } catch {
      localStorage.removeItem(TOKEN_KEY);
      state.token = null;
    }
  }
  showAuth();
}

init();
