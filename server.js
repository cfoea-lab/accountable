// server.js — Accountable: shared health accountability app for Logan & Reiner
// Zero-dependency Node.js server. Storage is async via db.js (local SQLite file,
// or hosted Turso/libSQL when TURSO_URL + TURSO_TOKEN are set — see README).
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const db = require('./db');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

/* ---------- helpers ---------- */
function send(res, status, body, headers = {}) {
  const isObj = typeof body === 'object' && !(body instanceof Buffer);
  const data = isObj ? JSON.stringify(body) : body;
  res.writeHead(status, { 'Content-Type': isObj ? 'application/json' : 'text/plain', ...headers });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 15 * 1024 * 1024) { reject(new Error('Body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

// Save a data-URL photo into the DB, return stored name ('' if none provided).
async function savePhoto(dataUrl) {
  if (!dataUrl) return '';
  const m = /^data:image\/(png|jpe?g|webp);base64,(.+)$/.exec(dataUrl);
  if (!m) throw new Error('Unsupported image format');
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  const name = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  await db.run('INSERT INTO photos (name, mime, data) VALUES (?, ?, ?)', [name, `image/${m[1] === 'jpg' ? 'jpeg' : m[1]}`, m[2]]);
  return name;
}
async function deletePhoto(name) {
  if (!name) return;
  await db.run('DELETE FROM photos WHERE name = ?', [name]);
}

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const str = (v, d = '') => (typeof v === 'string' ? v.slice(0, 2000) : d);
const today = () => new Date().toISOString().slice(0, 10);

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const placeholders = (arr) => arr.map(() => '?').join(',');

/* ---------- domain logic ---------- */
const getGoals = (userId) => db.get('SELECT * FROM goals WHERE user_id = ?', [userId]);

// Attach exercises + sets to a list of workouts with two batched queries (no N+1).
async function withDetail(workouts) {
  if (!workouts.length) return [];
  const wids = workouts.map((w) => w.id);
  const exercises = await db.all(
    `SELECT * FROM exercises WHERE workout_id IN (${placeholders(wids)}) ORDER BY position, id`, wids);
  const eids = exercises.map((e) => e.id);
  const sets = eids.length
    ? await db.all(`SELECT * FROM sets WHERE exercise_id IN (${placeholders(eids)}) ORDER BY position, id`, eids)
    : [];
  const setsByEx = new Map();
  for (const s of sets) {
    if (!setsByEx.has(s.exercise_id)) setsByEx.set(s.exercise_id, []);
    setsByEx.get(s.exercise_id).push(s);
  }
  const exByWo = new Map();
  for (const e of exercises) {
    if (!exByWo.has(e.workout_id)) exByWo.set(e.workout_id, []);
    exByWo.get(e.workout_id).push({ ...e, sets: setsByEx.get(e.id) || [] });
  }
  return workouts.map((w) => ({ ...w, exercises: exByWo.get(w.id) || [] }));
}

async function dayStatus(userId, date) {
  const [goals, meals, workoutsRaw, restRow, weightRow] = await Promise.all([
    getGoals(userId),
    db.all('SELECT * FROM meals WHERE user_id = ? AND date = ? ORDER BY time, id', [userId, date]),
    db.all('SELECT * FROM workouts WHERE user_id = ? AND date = ? ORDER BY id', [userId, date]),
    db.get('SELECT 1 AS x FROM rest_days WHERE user_id = ? AND date = ?', [userId, date]),
    db.get('SELECT kg FROM weights WHERE user_id = ? AND date = ?', [userId, date]),
  ]);
  const workouts = await withDetail(workoutsRaw);
  const rest = !!restRow;

  const totals = meals.reduce(
    (t, m) => ({ calories: t.calories + m.calories, protein: t.protein + m.protein, carbs: t.carbs + m.carbs, fat: t.fat + m.fat }),
    { calories: 0, protein: 0, carbs: 0, fat: 0 }
  );
  const mealPhotos = meals.filter((m) => m.photo).length;
  const workoutPhotos = workouts.filter((w) => w.photo).length;
  const trained = workouts.length > 0;

  const missed = [];
  if (meals.length === 0) missed.push('No meals logged');
  if (!trained && !rest) missed.push('No workout (or rest day) logged');
  if (meals.length > 0 && mealPhotos === 0) missed.push('No meal photo');
  if (trained && workoutPhotos === 0) missed.push('No workout photo');

  const complete = meals.length > 0 && (trained || rest);
  return {
    date, userId, goals, meals, workouts, rest,
    weight: weightRow ? weightRow.kg : null,
    totals, mealPhotos, workoutPhotos, trained, missed, complete,
  };
}

// Set of "complete days" (≥1 meal AND (workout OR rest day)) in [from..to] — 3 queries total.
async function completeDaySet(userId, from, to) {
  const [mealD, woD, restD] = await Promise.all([
    db.all('SELECT DISTINCT date FROM meals WHERE user_id = ? AND date >= ? AND date <= ?', [userId, from, to]),
    db.all('SELECT DISTINCT date FROM workouts WHERE user_id = ? AND date >= ? AND date <= ?', [userId, from, to]),
    db.all('SELECT date FROM rest_days WHERE user_id = ? AND date >= ? AND date <= ?', [userId, from, to]),
  ]);
  const meals = new Set(mealD.map((r) => r.date));
  const active = new Set([...woD.map((r) => r.date), ...restD.map((r) => r.date)]);
  const complete = new Set();
  for (const d of meals) if (active.has(d)) complete.add(d);
  return complete;
}

// Streak of consecutive complete days ending today (or yesterday if today isn't complete yet).
async function streak(userId, todayStr) {
  const from = addDays(todayStr, -400);
  const complete = await completeDaySet(userId, from, todayStr);
  let count = 0;
  let d = complete.has(todayStr) ? todayStr : addDays(todayStr, -1);
  while (complete.has(d)) { count += 1; d = addDays(d, -1); }
  return count;
}

async function progress(userId, todayStr, days) {
  const from = addDays(todayStr, -(days - 1));
  const [goals, weights, mealDaily, workoutD, restD, totalRow, streakN] = await Promise.all([
    getGoals(userId),
    db.all('SELECT date, kg FROM weights WHERE user_id = ? AND date >= ? AND date <= ? ORDER BY date', [userId, from, todayStr]),
    db.all(
      `SELECT date, SUM(calories) AS calories, SUM(protein) AS protein, SUM(carbs) AS carbs,
              SUM(fat) AS fat, COUNT(*) AS meals
       FROM meals WHERE user_id = ? AND date >= ? AND date <= ? GROUP BY date ORDER BY date`,
      [userId, from, todayStr]),
    db.all('SELECT DISTINCT date FROM workouts WHERE user_id = ? AND date >= ? AND date <= ?', [userId, from, todayStr]),
    db.all('SELECT date FROM rest_days WHERE user_id = ? AND date >= ? AND date <= ?', [userId, from, todayStr]),
    db.get('SELECT COUNT(*) AS n FROM workouts WHERE user_id = ? AND date >= ? AND date <= ?', [userId, from, todayStr]),
    streak(userId, todayStr),
  ]);

  const mealMap = new Map(mealDaily.map((r) => [r.date, r]));
  const woSet = new Set(workoutD.map((r) => r.date));
  const restSet = new Set(restD.map((r) => r.date));
  const daysArr = [];
  for (let d = from; d <= todayStr; d = addDays(d, 1)) {
    const m = mealMap.get(d);
    daysArr.push({
      date: d,
      calories: m ? m.calories : 0,
      protein: m ? m.protein : 0,
      meals: m ? m.meals : 0,
      trained: woSet.has(d),
      rest: restSet.has(d),
      complete: !!(m && m.meals > 0 && (woSet.has(d) || restSet.has(d))),
    });
  }
  return { userId, from, to: todayStr, goals, weights, days: daysArr, totalWorkouts: totalRow.n, streak: streakN };
}

/* ---------- API router ---------- */
const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

// --- summary (dashboard) ---
route('GET', /^\/api\/summary$/, async (req, res, q) => {
  const date = isDate(q.get('date')) ? q.get('date') : today();
  const users = await db.all('SELECT * FROM users ORDER BY id');
  const out = await Promise.all(users.map(async (u) => {
    const [status, st, latestWeight, unseenNudges] = await Promise.all([
      dayStatus(u.id, date),
      streak(u.id, date),
      db.get('SELECT kg, date FROM weights WHERE user_id = ? ORDER BY date DESC LIMIT 1', [u.id]),
      db.all(
        `SELECT n.*, u.name AS from_name FROM nudges n JOIN users u ON u.id = n.from_user
         WHERE n.to_user = ? AND n.seen = 0 ORDER BY n.id DESC`, [u.id]),
    ]);
    return { ...status, name: u.name, streak: st, latestWeight: latestWeight || null, unseenNudges };
  }));
  send(res, 200, { date, users: out });
});

// --- meals ---
route('GET', /^\/api\/meals$/, async (req, res, q) => {
  const userId = num(q.get('user'));
  const from = q.get('from'), to = q.get('to');
  let rows;
  if (isDate(from) && isDate(to)) {
    rows = await db.all('SELECT * FROM meals WHERE user_id = ? AND date >= ? AND date <= ? ORDER BY date DESC, time DESC, id DESC', [userId, from, to]);
  } else {
    const date = isDate(q.get('date')) ? q.get('date') : today();
    rows = await db.all('SELECT * FROM meals WHERE user_id = ? AND date = ? ORDER BY time, id', [userId, date]);
  }
  send(res, 200, rows);
});

route('POST', /^\/api\/meals$/, async (req, res) => {
  const b = await readBody(req);
  if (!isDate(b.date)) return send(res, 400, { error: 'date required (YYYY-MM-DD)' });
  const photo = await savePhoto(b.photoData);
  const info = await db.run(
    `INSERT INTO meals (user_id, date, time, type, name, calories, protein, carbs, fat, notes, photo)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [num(b.userId), b.date, str(b.time), str(b.type, 'meal'), str(b.name), num(b.calories), num(b.protein), num(b.carbs), num(b.fat), str(b.notes), photo]);
  send(res, 201, await db.get('SELECT * FROM meals WHERE id = ?', [info.lastInsertRowid]));
});

route('PUT', /^\/api\/meals\/(\d+)$/, async (req, res, q, m) => {
  const id = num(m[1]);
  const existing = await db.get('SELECT * FROM meals WHERE id = ?', [id]);
  if (!existing) return send(res, 404, { error: 'Not found' });
  const b = await readBody(req);
  let photo = existing.photo;
  if (b.photoData) { await deletePhoto(existing.photo); photo = await savePhoto(b.photoData); }
  else if (b.removePhoto) { await deletePhoto(existing.photo); photo = ''; }
  await db.run(
    'UPDATE meals SET date=?, time=?, type=?, name=?, calories=?, protein=?, carbs=?, fat=?, notes=?, photo=? WHERE id=?',
    [isDate(b.date) ? b.date : existing.date, str(b.time, existing.time), str(b.type, existing.type), str(b.name, existing.name),
     num(b.calories, existing.calories), num(b.protein, existing.protein), num(b.carbs, existing.carbs), num(b.fat, existing.fat),
     str(b.notes, existing.notes), photo, id]);
  send(res, 200, await db.get('SELECT * FROM meals WHERE id = ?', [id]));
});

route('DELETE', /^\/api\/meals\/(\d+)$/, async (req, res, q, m) => {
  const existing = await db.get('SELECT * FROM meals WHERE id = ?', [num(m[1])]);
  if (!existing) return send(res, 404, { error: 'Not found' });
  await deletePhoto(existing.photo);
  await db.run('DELETE FROM meals WHERE id = ?', [existing.id]);
  send(res, 200, { ok: true });
});

// --- workouts ---
route('GET', /^\/api\/workouts$/, async (req, res, q) => {
  const userId = num(q.get('user'));
  const limit = Math.min(num(q.get('limit'), 30), 200);
  const rows = await db.all('SELECT * FROM workouts WHERE user_id = ? ORDER BY date DESC, id DESC LIMIT ?', [userId, limit]);
  send(res, 200, await withDetail(rows));
});

async function writeExercises(workoutId, exercises) {
  const old = await db.all('SELECT id FROM exercises WHERE workout_id = ?', [workoutId]);
  if (old.length) {
    const ids = old.map((e) => e.id);
    await db.run(`DELETE FROM sets WHERE exercise_id IN (${placeholders(ids)})`, ids);
    await db.run('DELETE FROM exercises WHERE workout_id = ?', [workoutId]);
  }
  let i = 0;
  for (const ex of Array.isArray(exercises) ? exercises : []) {
    const name = str(ex.name).trim();
    if (!name) continue;
    const info = await db.run('INSERT INTO exercises (workout_id, name, position) VALUES (?, ?, ?)', [workoutId, name, i++]);
    let j = 0;
    for (const s of Array.isArray(ex.sets) ? ex.sets : []) {
      await db.run('INSERT INTO sets (exercise_id, reps, weight, position) VALUES (?, ?, ?, ?)',
        [info.lastInsertRowid, num(s.reps), num(s.weight), j++]);
    }
  }
}

route('POST', /^\/api\/workouts$/, async (req, res) => {
  const b = await readBody(req);
  if (!isDate(b.date)) return send(res, 400, { error: 'date required' });
  const photo = await savePhoto(b.photoData);
  const info = await db.run(
    'INSERT INTO workouts (user_id, date, title, notes, duration_min, photo) VALUES (?, ?, ?, ?, ?, ?)',
    [num(b.userId), b.date, str(b.title, 'Workout'), str(b.notes), num(b.durationMin), photo]);
  await writeExercises(info.lastInsertRowid, b.exercises);
  const w = await db.get('SELECT * FROM workouts WHERE id = ?', [info.lastInsertRowid]);
  send(res, 201, (await withDetail([w]))[0]);
});

route('PUT', /^\/api\/workouts\/(\d+)$/, async (req, res, q, m) => {
  const id = num(m[1]);
  const existing = await db.get('SELECT * FROM workouts WHERE id = ?', [id]);
  if (!existing) return send(res, 404, { error: 'Not found' });
  const b = await readBody(req);
  let photo = existing.photo;
  if (b.photoData) { await deletePhoto(existing.photo); photo = await savePhoto(b.photoData); }
  else if (b.removePhoto) { await deletePhoto(existing.photo); photo = ''; }
  await db.run('UPDATE workouts SET date=?, title=?, notes=?, duration_min=?, photo=? WHERE id=?',
    [isDate(b.date) ? b.date : existing.date, str(b.title, existing.title), str(b.notes, existing.notes),
     num(b.durationMin, existing.duration_min), photo, id]);
  if (b.exercises) await writeExercises(id, b.exercises);
  const w = await db.get('SELECT * FROM workouts WHERE id = ?', [id]);
  send(res, 200, (await withDetail([w]))[0]);
});

route('DELETE', /^\/api\/workouts\/(\d+)$/, async (req, res, q, m) => {
  const existing = await db.get('SELECT * FROM workouts WHERE id = ?', [num(m[1])]);
  if (!existing) return send(res, 404, { error: 'Not found' });
  await deletePhoto(existing.photo);
  await writeExercises(existing.id, []); // clears exercises + sets
  await db.run('DELETE FROM workouts WHERE id = ?', [existing.id]);
  send(res, 200, { ok: true });
});

// --- rest day toggle ---
route('POST', /^\/api\/rest-day$/, async (req, res) => {
  const b = await readBody(req);
  if (!isDate(b.date)) return send(res, 400, { error: 'date required' });
  const userId = num(b.userId);
  const existing = await db.get('SELECT 1 AS x FROM rest_days WHERE user_id = ? AND date = ?', [userId, b.date]);
  if (existing) await db.run('DELETE FROM rest_days WHERE user_id = ? AND date = ?', [userId, b.date]);
  else await db.run('INSERT INTO rest_days (user_id, date) VALUES (?, ?)', [userId, b.date]);
  send(res, 200, { rest: !existing });
});

// --- weight ---
route('GET', /^\/api\/weights$/, async (req, res, q) => {
  send(res, 200, await db.all('SELECT * FROM weights WHERE user_id = ? ORDER BY date DESC LIMIT 365', [num(q.get('user'))]));
});
route('POST', /^\/api\/weights$/, async (req, res) => {
  const b = await readBody(req);
  if (!isDate(b.date) || !num(b.kg)) return send(res, 400, { error: 'date and kg required' });
  await db.run(
    `INSERT INTO weights (user_id, date, kg) VALUES (?, ?, ?)
     ON CONFLICT(user_id, date) DO UPDATE SET kg = excluded.kg`, [num(b.userId), b.date, num(b.kg)]);
  send(res, 201, { ok: true });
});
route('DELETE', /^\/api\/weights\/(\d+)$/, async (req, res, q, m) => {
  await db.run('DELETE FROM weights WHERE id = ?', [num(m[1])]);
  send(res, 200, { ok: true });
});

// --- goals ---
route('GET', /^\/api\/goals$/, async (req, res, q) => send(res, 200, await getGoals(num(q.get('user')))));
route('PUT', /^\/api\/goals$/, async (req, res) => {
  const b = await readBody(req);
  const userId = num(b.userId);
  const g = await getGoals(userId);
  if (!g) return send(res, 404, { error: 'No such user' });
  await db.run('UPDATE goals SET calories=?, protein=?, carbs=?, fat=?, workouts_per_week=?, meals_per_day=? WHERE user_id=?',
    [num(b.calories, g.calories), num(b.protein, g.protein), num(b.carbs, g.carbs), num(b.fat, g.fat),
     num(b.workoutsPerWeek, g.workouts_per_week), num(b.mealsPerDay, g.meals_per_day), userId]);
  send(res, 200, await getGoals(userId));
});

// --- nudges ---
route('GET', /^\/api\/nudges$/, async (req, res, q) => {
  send(res, 200, await db.all(
    `SELECT n.*, u.name AS from_name FROM nudges n JOIN users u ON u.id = n.from_user
     WHERE n.to_user = ? ORDER BY n.id DESC LIMIT 50`, [num(q.get('user'))]));
});
route('POST', /^\/api\/nudges$/, async (req, res) => {
  const b = await readBody(req);
  const info = await db.run('INSERT INTO nudges (from_user, to_user, reason, message, date) VALUES (?, ?, ?, ?, ?)',
    [num(b.fromUser), num(b.toUser), str(b.reason), str(b.message), isDate(b.date) ? b.date : today()]);
  send(res, 201, await db.get('SELECT * FROM nudges WHERE id = ?', [info.lastInsertRowid]));
});
route('POST', /^\/api\/nudges\/(\d+)\/seen$/, async (req, res, q, m) => {
  await db.run('UPDATE nudges SET seen = 1 WHERE id = ?', [num(m[1])]);
  send(res, 200, { ok: true });
});

// --- progress ---
route('GET', /^\/api\/progress$/, async (req, res, q) => {
  const userId = num(q.get('user'));
  const days = Math.min(Math.max(num(q.get('days'), 30), 7), 365);
  const date = isDate(q.get('date')) ? q.get('date') : today();
  send(res, 200, await progress(userId, date, days));
});

// --- users / health ---
route('GET', /^\/api\/users$/, async (req, res) => send(res, 200, await db.all('SELECT * FROM users ORDER BY id')));
route('GET', /^\/api\/health$/, async (req, res) => send(res, 200, { ok: true, driver: db.driverName }));

/* ---------- server ---------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);

  try {
    if (pathname.startsWith('/api/')) {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.pattern.exec(pathname);
        if (m) return await r.handler(req, res, url.searchParams, m);
      }
      return send(res, 404, { error: 'Not found' });
    }

    // Photos (stored in the database)
    if (pathname.startsWith('/uploads/')) {
      const name = path.basename(pathname);
      const row = await db.get('SELECT mime, data FROM photos WHERE name = ?', [name]);
      if (!row) return send(res, 404, 'Not found');
      const buf = Buffer.from(row.data, 'base64');
      res.writeHead(200, { 'Content-Type': row.mime, 'Content-Length': buf.length, 'Cache-Control': 'public, max-age=31536000, immutable' });
      return res.end(buf);
    }

    // Static frontend
    let file = path.normalize(path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname));
    if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, 'Forbidden');
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC_DIR, 'index.html');
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    return fs.createReadStream(file).pipe(res);
  } catch (err) {
    console.error(`${req.method} ${pathname} →`, err.message);
    const client = ['Invalid JSON', 'Body too large', 'Unsupported image format'].includes(err.message);
    return send(res, client ? 400 : 500, { error: err.message });
  }
});

db.init().then(() => {
  server.listen(PORT, () => console.log(`Accountable running → http://localhost:${PORT}`));
}).catch((err) => {
  console.error('Storage init failed:', err.message);
  process.exit(1);
});
