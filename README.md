# Key Time 🔑⏰

A PWA (works on desktop and phone) that sends you a **"It's key time!"** push
notification on an interval you choose. Whatever "key time" means to *you* —
the app doesn't care, it just keeps the rhythm.

The twist: **the next timer does not start when the notification is sent.**
It starts only when you open the notification and tap **Start next timer**.
So the clock measures *your* cycle, not a fixed wall schedule.

There are statistics: when the first key time happened, every one since, and
the gap between them.

## How it works

- **Frontend** — vanilla JS PWA: service worker, Web Push subscription, live
  countdown, settings, and stats. No build step.
- **Backend** — Node + Express + [`web-push`](https://www.npmjs.com/package/web-push).
  Stores subscriptions/timers in a JSON file and runs a scheduler that sends the
  push when a timer is due, then stops the timer until you restart it.

```
server/   Express API + scheduler + JSON store
public/   the PWA (static files)
data/     records.json (created at runtime, git-ignored)
```

## Run locally

```bash
npm install

# generate Web Push keys, then paste them into .env
cp .env.example .env
npm run gen-vapid        # prints VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY

npm start                # http://localhost:3000
```

Open http://localhost:3000, click **Enable notifications**, set an interval,
and **Start timer**. (Web Push needs `localhost` or HTTPS — both work.)

## API

| Method | Path              | Purpose                                        |
|--------|-------------------|------------------------------------------------|
| GET    | `/api/config`     | VAPID public key + whether push is configured  |
| POST   | `/api/subscribe`  | save push subscription + interval, get an `id` |
| POST   | `/api/settings`   | update the interval                            |
| POST   | `/api/start`      | start/restart the timer                        |
| POST   | `/api/stop`       | stop the timer                                 |
| GET    | `/api/state?id=`  | current timer state + key-time history         |
| POST   | `/api/tick`       | process due timers (for external cron)         |

## Deploying (free tier)

Any Node host works (Render, Fly, Railway, etc.). Two things to know:

1. **Persistence** — the JSON store lives in `data/`. On hosts with an
   ephemeral filesystem (e.g. Render free), attach a persistent disk mounted at
   `data/`, or swap `server/store.js` for Postgres.
2. **Sleeping hosts** — if the host sleeps when idle, the in-process scheduler
   pauses and pushes won't fire. Set `TICK_SECRET` and have an external cron
   (e.g. [cron-job.org](https://cron-job.org)) `POST /api/tick` every minute
   with header `x-tick-secret: <your secret>`. That both wakes the app and
   fires due notifications.

## Notes on notifications

- Works on Android (Chrome/Edge/Firefox) and desktop Chromium/Firefox.
- **iOS/iPadOS**: Web Push requires iOS 16.4+ **and** the app must be added to
  the Home Screen first (Share → Add to Home Screen), then opened from there.
