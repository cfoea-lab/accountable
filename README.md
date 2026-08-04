# Accountable

A shared health accountability app for **Logan** and **Reiner**. One place to log workouts, meals, macros, weight, and photos — and to see at a glance who's on track and who needs a nudge.

## Zero dependencies

No npm install. No frameworks. No paid services. The whole app is plain Node.js (built-in SQLite) + one HTML/CSS/JS frontend.

**Requirement: Node.js 22.5 or newer** (for the built-in `node:sqlite` module).

## Run it

```bash
node server.js
```

Open http://localhost:3000. That's it. The database (`data/accountable.db`) and both user profiles are created automatically on first run.

Optional — fill it with 3 weeks of realistic demo data to explore:

```bash
node seed-demo.js        # while the server is running
```

To wipe everything and start fresh: stop the server and delete the `data/` and `uploads/` folders.

## Using it from two phones

Both of you need to reach the same server:

- **Same wifi:** run it on any computer at home, open `http://<that-computer's-ip>:3000` from your phones.
- **From anywhere, free (Render + Turso):** Render's free tier has an ephemeral filesystem, so the app supports a hosted database instead of the local file. Photos are stored in the database too, so nothing is ever lost.
  1. Create a free database at [turso.tech](https://turso.tech) and note its URL and an auth token.
  2. On [render.com](https://render.com), create a **Web Service** from this repo (public-repo URL works, no GitHub connection needed). Runtime Node, start command `node server.js`, instance type **Free**.
  3. Add environment variables `TURSO_URL` (the database URL) and `TURSO_TOKEN` (the token). Deploy.
  - With those two variables set, the app uses Turso; without them, it uses the local SQLite file. Same code, no other changes.
  - Free-tier note: the service sleeps after 15 idle minutes; the first visit after that takes ~1 minute to wake. Data is never affected.
- Or run it at home and share it privately with Tailscale (free for personal use).

On your phone, use the browser's **Add to Home Screen** — the app is a full PWA (manifest + service worker + icons), so when served over HTTPS it installs like a native app, opens full-screen, and shows last-loaded data when briefly offline. See **DEPLOY-GUIDE.md** for a beginner-friendly, step-by-step walkthrough of both wifi access and free hosting.

## How it works day to day

- **Top bar:** switch who's acting — Logan or Reiner. You always see both people's data; you log as yourself.
- **Today:** both of your daily snapshots — workout status, calories eaten/left, macro bars, photos, streak, and exactly what's still missing today. Quick buttons to log a meal, workout, weight, or mark a rest day.
- **Nudges:** on your partner's card, hit *Nudge* — it shows what they've missed, you pick a reason and an optional message, and it appears as a banner on their screen until they acknowledge it.
- **Food:** log meals in ~20 seconds — type, name, time, calories, protein/carbs/fat, notes, photo. Tap any meal to edit or delete. Your partner's meals for the day are shown below yours.
- **Train:** Hevy-style logging — exercises (with autocomplete for ~40 common movements), sets, reps, weight, duration, notes, photo. History shows each workout with best sets and total volume. Tap to edit.
- **Progress:** per person, over 7/30/90 days — streak, workouts vs goal, average calories, weight trend chart, calories-per-day chart vs goal, and a consistency grid. Goals (calories, macros, workouts/week) are edited here too.

### What counts as a "complete day" (for the streak)

At least one meal logged **and** either a workout logged or the day marked as a rest day. The streak counts consecutive complete days.

## Data & backups

Running locally, everything lives in `data/accountable.db` (SQLite) — logs, goals, nudges, and photos (photos are stored in the database, downscaled on the phone before upload so storage stays small). Back up by copying the `data/` folder.

Running hosted (Turso), everything lives in your Turso database — Turso keeps its own backups with point-in-time restore.

## Architecture (for the curious)

```
server.js   — HTTP server + REST API (pure node:http)
db.js       — schema + SQLite via built-in node:sqlite
public/     — the app: index.html, app.css, app.js (vanilla SPA)
```

No build step, no ORM, no framework. Grayscale UI (white, light gray, charcoal) by design.
