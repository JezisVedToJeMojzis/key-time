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

## Deploying to Render (free tier)

The whole app (frontend + backend) runs as one Render Web Service. A
[`render.yaml`](render.yaml) blueprint is included.

### 1. Database (required)

Render's free filesystem is ephemeral, so the store must be Postgres. Create a
free **Neon** Postgres database and copy its connection string. The app creates
its own table on first boot — no migrations needed. (Locally, leave
`DATABASE_URL` unset and it uses `data/records.json` instead.)

### 2. Create the service

Render Dashboard → **New → Blueprint** → pick the `key-time` repo. It reads
`render.yaml`. Then set these env vars (the secret ones aren't in the file):

| Var                 | Value                                            |
|---------------------|--------------------------------------------------|
| `VAPID_PUBLIC_KEY`  | from `npm run gen-vapid` (or your local `.env`)  |
| `VAPID_PRIVATE_KEY` | from `npm run gen-vapid` (or your local `.env`)  |
| `VAPID_SUBJECT`     | `mailto:you@example.com`                          |
| `DATABASE_URL`      | your Neon connection string                       |
| `TICK_SECRET`       | any random string                                 |

### 3. Keep it awake so timers fire

Render free services sleep after ~15 min idle, which pauses the in-process
scheduler. Add a free external cron (e.g. [cron-job.org](https://cron-job.org))
that sends every minute:

```
POST https://<your-app>.onrender.com/api/tick
Header: x-tick-secret: <your TICK_SECRET>
```

That wakes the service and fires any due notifications (within ~1 min of due
time). Notifications keep working even with the app fully closed.

## Notes on notifications

- Works on Android (Chrome/Edge/Firefox) and desktop Chromium/Firefox.
- **iOS/iPadOS**: Web Push requires iOS 16.4+ **and** the app must be added to
  the Home Screen first (Share → Add to Home Screen), then opened from there.
