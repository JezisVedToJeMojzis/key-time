// Standalone scheduler tick: connect to the store, send any due "It's key time!"
// pushes, then exit. Designed to run on an external schedule (e.g. GitHub
// Actions) so the web service itself can stay asleep on free hosting.
//
// Requires DATABASE_URL + VAPID_* in the environment (so it talks to the same
// Postgres the web app uses, and signs pushes with the same VAPID keys).
try {
  process.loadEnvFile();
} catch {
  /* no .env file — rely on real environment variables */
}

const store = await import('../server/store.js');
const { tick, vapidConfigured } = await import('../server/push.js');

if (!process.env.DATABASE_URL) {
  console.error('[tick] DATABASE_URL is required for the standalone tick.');
  process.exit(1);
}
if (!vapidConfigured) {
  console.error('[tick] VAPID keys missing — cannot send pushes.');
  process.exit(1);
}

await store.init();
const sent = await tick();
console.log(`[tick] processed due timers, sent ${sent} notification(s)`);
process.exit(0);
