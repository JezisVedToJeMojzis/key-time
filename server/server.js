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

const { tick, getPublicKey, vapidConfigured } = await import('./push.js');
const store = await import('./store.js');

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

// --- Subscribe / settings ------------------------------------------------
app.post('/api/subscribe', (req, res) => {
  const { id, subscription, intervalMs } = req.body || {};
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: 'subscription required' });
  }
  const rec = store.upsertSubscription({ id, subscription, intervalMs });
  res.json(publicState(rec));
});

app.post('/api/settings', (req, res) => {
  const { id, intervalMs } = req.body || {};
  if (!id || typeof intervalMs !== 'number' || intervalMs <= 0) {
    return res.status(400).json({ error: 'id and positive intervalMs required' });
  }
  const rec = store.setInterval_(id, intervalMs);
  if (!rec) return res.status(404).json({ error: 'not found' });
  res.json(publicState(rec));
});

// --- Timer control -------------------------------------------------------
app.post('/api/start', (req, res) => {
  const rec = store.startTimer(req.body?.id);
  if (!rec) return res.status(404).json({ error: 'not found' });
  res.json(publicState(rec));
});

app.post('/api/stop', (req, res) => {
  const rec = store.stopTimer(req.body?.id);
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

app.listen(PORT, () => {
  console.log(`Key Time running on http://localhost:${PORT}`);
  if (!vapidConfigured) {
    console.log('Push disabled — run `npm run gen-vapid` and add keys to .env.');
  }
});
