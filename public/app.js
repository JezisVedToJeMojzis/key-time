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
};

const ID_KEY = 'keytime.id';
const INTERVAL_KEY = 'keytime.intervalMs';

const state = {
  id: localStorage.getItem(ID_KEY) || null,
  config: null,
  server: null,       // last /api/state response
  clockOffset: 0,     // serverNow - clientNow
};

// --- API helpers ---------------------------------------------------------
async function api(path, method = 'GET', body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
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

// --- Init ----------------------------------------------------------------
async function init() {
  els.startBtn.addEventListener('click', startTimer);
  els.fireBtn.addEventListener('click', fireNow);
  els.stopBtn.addEventListener('click', stopTimer);
  els.resetBtn.addEventListener('click', resetSession);
  els.reportDone.addEventListener('click', () => els.reportCard.classList.add('hidden'));
  els.bannerStart.addEventListener('click', startTimer);
  els.saveSettings.addEventListener('click', saveSettings);
  els.enableBtn?.addEventListener('click', enableNotifications);

  // restore saved interval into the form
  const savedInterval = Number(localStorage.getItem(INTERVAL_KEY));
  if (savedInterval) fillIntervalInputs(savedInterval);

  if (new URLSearchParams(location.search).get('keytime') === '1') showBanner();

  await registerSW();
  try {
    state.config = await api('/api/config');
  } catch {
    els.connStatus.textContent = 'server offline';
  }

  await ensureSubscription();
  await refreshState();
  render();

  // sync from server periodically; tick the countdown every second
  setInterval(refreshState, 10000);
  setInterval(updateCountdown, 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshState();
  });
}

init();
