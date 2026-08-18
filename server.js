// server.js — Accountable: shared health accountability app for Logan & Reiner
// Zero-dependency Node.js server. Storage is async via db.js (local SQLite file,
// or hosted Turso/libSQL when TURSO_URL + TURSO_TOKEN are set — see README).
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const db = require('./db');
const webpush = require('./webpush');

const PORT = process.env.PORT || 3000;

// VAPID identity for push notifications — generated once, kept in the database.
let VAPID = null;
async function ensureVapid() {
  const row = await db.get('SELECT value FROM config WHERE key = ?', ['vapid']);
  if (row) {
    VAPID = JSON.parse(row.value);
  } else {
    const keys = webpush.generateVapidKeys();
    VAPID = { ...keys, subject: 'mailto:cfo.ea@legionsupplements.com' };
    await db.run('INSERT INTO config (key, value) VALUES (?, ?)', ['vapid', JSON.stringify(VAPID)]);
  }
}

// Send a push to every device a user has enabled; prune dead subscriptions.
async function notifyUser(userId, payload) {
  // Returns how many devices actually accepted the push. Worth surfacing: when
  // testing on the live server, "pushed: 2, delivered: 0" tells you the recap ran
  // fine and nobody has notifications enabled — a very different problem from the
  // recap failing to generate.
  let delivered = 0;
  try {
    const subs = await db.all('SELECT * FROM push_subs WHERE user_id = ?', [userId]);
    for (const sub of subs) {
      try {
        const status = await webpush.sendPush(sub, payload, VAPID);
        if (status === 404 || status === 410) await db.run('DELETE FROM push_subs WHERE id = ?', [sub.id]);
        else if (status >= 200 && status < 300) delivered++;
      } catch (err) {
        console.error('push send failed:', err.message);
      }
    }
  } catch (err) {
    console.error('notifyUser failed:', err.message);
  }
  return delivered;
}
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
// Canonical app timezone. Everything (day boundaries, week boundaries, the weekly
// recap schedule) is anchored here so the server and every device agree regardless
// of where the phone happens to be. America/New_York handles the EST/EDT switch;
// pinning a literal UTC-5 would drift by an hour for half the year.
const APP_TZ = 'America/New_York';
const _tzDate = new Intl.DateTimeFormat('en-CA', { timeZone: APP_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const _tzTime = new Intl.DateTimeFormat('en-GB', { timeZone: APP_TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const _tzWeekday = new Intl.DateTimeFormat('en-US', { timeZone: APP_TZ, weekday: 'short' });
const today = () => _tzDate.format(new Date());
const nowTimeTZ = () => _tzTime.format(new Date());
// 0 = Monday … 6 = Sunday, in app timezone
const WD = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
const weekdayIdx = (d = new Date()) => WD[_tzWeekday.format(d)];
// Monday of the week containing dateStr
const mondayOf = (dateStr) => {
  const d = new Date(dateStr + 'T12:00:00Z');
  const dow = (d.getUTCDay() + 6) % 7;
  return addDays(dateStr, -dow);
};

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
/* ---------- meal ingredients ----------
   A meal can be a list of ingredients. The meal's own macro columns remain the
   single source of truth for every existing query, chart and streak calculation —
   when items are present we simply recompute those columns as the sum. Meals
   logged before this feature have no items and behave exactly as they always did. */

const round1s = (n) => Math.round((Number(n) || 0) * 10) / 10;

/* Cooked/raw conversion.
   A food row stores macros per 100 g in ONE state (its `state` column), and
   `yield_factor` is how many grams of cooked food you get per gram raw — under 1
   for meat, which loses water, over 1 for grains and legumes, which absorb it.
   If the user weighed their food in the other state, convert their grams onto the
   food's own scale before doing macro maths. When we don't know the food's state,
   we return the weight untouched rather than guessing. */
function convertGrams(grams, enteredState, food) {
  const g = Number(grams) || 0;
  if (!food || !food.yield_factor || food.state === 'na') return g;
  if (!['raw', 'cooked'].includes(enteredState) || enteredState === food.state) return g;
  return food.state === 'raw' ? g / food.yield_factor : g * food.yield_factor;
}

// Attach items to a list of meals in one query (no N+1).
async function withItems(meals) {
  if (!meals.length) return meals;
  const ids = meals.map((m) => m.id);
  const items = await db.all(
    `SELECT * FROM meal_items WHERE meal_id IN (${placeholders(ids)}) ORDER BY meal_id, sort, id`, ids);
  const byMeal = new Map();
  for (const it of items) {
    if (!byMeal.has(it.meal_id)) byMeal.set(it.meal_id, []);
    byMeal.get(it.meal_id).push(it);
  }
  return meals.map((m) => ({ ...m, items: byMeal.get(m.id) || [] }));
}

// Replace a meal's ingredient rows and return the summed macros.
async function writeItems(mealId, items) {
  await db.run('DELETE FROM meal_items WHERE meal_id = ?', [mealId]);
  const list = Array.isArray(items) ? items.filter((i) => i && (str(i.name).trim() || num(i.calories))) : [];
  const total = { calories: 0, protein: 0, carbs: 0, fat: 0 };
  let i = 0;
  for (const it of list) {
    const row = {
      calories: num(it.calories), protein: num(it.protein), carbs: num(it.carbs), fat: num(it.fat),
    };
    await db.run(
      `INSERT INTO meal_items (meal_id, food_id, name, grams, entered_qty, entered_unit, state,
                               calories, protein, carbs, fat, source, sort)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [mealId, num(it.foodId) || null, str(it.name).trim(), num(it.grams),
       it.enteredQty == null ? null : num(it.enteredQty), str(it.enteredUnit, 'g'),
       ['raw', 'cooked'].includes(it.state) ? it.state : 'na',
       row.calories, row.protein, row.carbs, row.fat,
       ['db', 'ai', 'manual', 'mine'].includes(it.source) ? it.source : 'manual', i++]);
    total.calories += row.calories; total.protein += row.protein;
    total.carbs += row.carbs; total.fat += row.fat;
  }
  return {
    count: list.length,
    calories: Math.round(total.calories),
    protein: round1s(total.protein), carbs: round1s(total.carbs), fat: round1s(total.fat),
  };
}

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
  send(res, 200, await withItems(rows));
});

route('POST', /^\/api\/meals$/, async (req, res) => {
  const b = await readBody(req);
  if (!isDate(b.date)) return send(res, 400, { error: 'date required (YYYY-MM-DD)' });
  const photo = await savePhoto(b.photoData);
  const info = await db.run(
    `INSERT INTO meals (user_id, date, time, type, name, calories, protein, carbs, fat, notes, photo, food_id, grams)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [num(b.userId), b.date, str(b.time), str(b.type, 'meal'), str(b.name), num(b.calories), num(b.protein), num(b.carbs), num(b.fat), str(b.notes), photo,
     num(b.foodId) || null, num(b.grams) || null]);
  const id = info.lastInsertRowid;
  if (Array.isArray(b.items)) {
    const t = await writeItems(id, b.items);
    // Ingredient rows win over any totals the client sent, unless the user has
    // explicitly overridden the total (b.overrideTotals).
    if (t.count && !b.overrideTotals) {
      await db.run('UPDATE meals SET calories=?, protein=?, carbs=?, fat=? WHERE id=?',
        [t.calories, t.protein, t.carbs, t.fat, id]);
    }
  }
  const [meal] = await withItems([await db.get('SELECT * FROM meals WHERE id = ?', [id])]);
  send(res, 201, meal);
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
    'UPDATE meals SET date=?, time=?, type=?, name=?, calories=?, protein=?, carbs=?, fat=?, notes=?, photo=?, food_id=?, grams=? WHERE id=?',
    [isDate(b.date) ? b.date : existing.date, str(b.time, existing.time), str(b.type, existing.type), str(b.name, existing.name),
     num(b.calories, existing.calories), num(b.protein, existing.protein), num(b.carbs, existing.carbs), num(b.fat, existing.fat),
     str(b.notes, existing.notes), photo, num(b.foodId, existing.food_id) || null, num(b.grams, existing.grams) || null, id]);
  if (Array.isArray(b.items)) {
    const t = await writeItems(id, b.items);
    if (t.count && !b.overrideTotals) {
      await db.run('UPDATE meals SET calories=?, protein=?, carbs=?, fat=? WHERE id=?',
        [t.calories, t.protein, t.carbs, t.fat, id]);
    }
  }
  const [meal] = await withItems([await db.get('SELECT * FROM meals WHERE id = ?', [id])]);
  send(res, 200, meal);
});

route('DELETE', /^\/api\/meals\/(\d+)$/, async (req, res, q, m) => {
  const existing = await db.get('SELECT * FROM meals WHERE id = ?', [num(m[1])]);
  if (!existing) return send(res, 404, { error: 'Not found' });
  await deletePhoto(existing.photo);
  await db.run('DELETE FROM meal_items WHERE meal_id = ?', [existing.id]);
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
      await db.run('INSERT INTO sets (exercise_id, reps, weight, position, set_type) VALUES (?, ?, ?, ?, ?)',
        [info.lastInsertRowid, num(s.reps), num(s.weight), j++, ['warmup', 'failure', 'drop'].includes(s.type) ? s.type : 'normal']);
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
  const nudge = await db.get('SELECT * FROM nudges WHERE id = ?', [info.lastInsertRowid]);
  // Fire the push notification without delaying the response
  db.get('SELECT name FROM users WHERE id = ?', [nudge.from_user]).then((from) =>
    notifyUser(nudge.to_user, {
      title: `${from ? from.name : 'Your partner'} nudged you`,
      body: nudge.reason + (nudge.message ? ` — “${nudge.message}”` : ''),
      url: '/',
    })
  ).catch(() => {});
  send(res, 201, nudge);
});

// --- push notifications ---
route('GET', /^\/api\/push\/pubkey$/, async (req, res) => send(res, 200, { key: VAPID.publicKey }));
route('POST', /^\/api\/push\/subscribe$/, async (req, res) => {
  const b = await readBody(req);
  const s = b.subscription || {};
  if (!s.endpoint || !s.keys || !s.keys.p256dh || !s.keys.auth) return send(res, 400, { error: 'Invalid subscription' });
  await db.run(
    `INSERT INTO push_subs (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`,
    [num(b.userId), s.endpoint.slice(0, 1000), s.keys.p256dh, s.keys.auth]);
  send(res, 201, { ok: true });
});
route('POST', /^\/api\/push\/unsubscribe$/, async (req, res) => {
  const b = await readBody(req);
  await db.run('DELETE FROM push_subs WHERE endpoint = ?', [str(b.endpoint, '').slice(0, 1000)]);
  send(res, 200, { ok: true });
});
route('POST', /^\/api\/nudges\/(\d+)\/seen$/, async (req, res, q, m) => {
  await db.run('UPDATE nudges SET seen = 1 WHERE id = ?', [num(m[1])]);
  send(res, 200, { ok: true });
});

// --- food database & search ---
route('GET', /^\/api\/foods$/, async (req, res, q) => {
  const userId = num(q.get('user'));
  const query = str(q.get('q'), '').trim().toLowerCase();
  if (!query) {
    const [myFoods, recents] = await Promise.all([
      db.all('SELECT * FROM user_foods WHERE user_id = ? ORDER BY id DESC LIMIT 15', [userId]),
      db.all(
        `SELECT name, MAX(food_id) AS food_id, MAX(grams) AS grams, MAX(calories) AS calories,
                MAX(protein) AS protein, MAX(carbs) AS carbs, MAX(fat) AS fat, MAX(id) AS mid
         FROM meals WHERE user_id = ? AND name != '' GROUP BY lower(name) ORDER BY mid DESC LIMIT 10`, [userId]),
    ]);
    return send(res, 200, { myFoods, recents });
  }
  const like = `%${query}%`;
  const prefix = `${query}%`;
  const [mine, foods] = await Promise.all([
    db.all(`SELECT * FROM user_foods WHERE user_id = ? AND lower(name) LIKE ? ORDER BY length(name) LIMIT 6`, [userId, like]),
    db.all(
      `SELECT * FROM foods WHERE lower(name) LIKE ?
       ORDER BY CASE WHEN lower(name) LIKE ? THEN 0 ELSE 1 END, length(name) LIMIT 25`, [like, prefix]),
  ]);
  send(res, 200, { mine, foods });
});

route('POST', /^\/api\/user-foods$/, async (req, res) => {
  const b = await readBody(req);
  if (!str(b.name).trim()) return send(res, 400, { error: 'name required' });
  await db.run(
    `INSERT INTO user_foods (user_id, name, kcal, protein, carbs, fat, portion_name, portion_grams)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [num(b.userId), str(b.name).trim().slice(0, 80), num(b.kcal), num(b.protein), num(b.carbs), num(b.fat),
     str(b.portionName) || null, num(b.portionGrams) || null]);
  send(res, 201, { ok: true });
});
route('DELETE', /^\/api\/user-foods\/(\d+)$/, async (req, res, q, m) => {
  await db.run('DELETE FROM user_foods WHERE id = ?', [num(m[1])]);
  send(res, 200, { ok: true });
});

// --- AI nutrition estimate (Gemini proxy — key stays server-side) ---
/* Returns an ingredient BREAKDOWN rather than one opaque blob, so every number is
   inspectable and editable. Each ingredient is then matched against our own foods
   table: where we have real data we use it and recompute from grams, and the model's
   guess is only kept for ingredients we don't have. Real data beats a language
   model's recollection of nutrition labels, and it costs nothing extra. */

const AI_SYSTEM = [
  'You are a nutrition estimator for a fitness app.',
  'Break the described or photographed meal into its individual ingredients.',
  'For each ingredient give the edible weight in grams for the portion actually eaten,',
  'and whether that weight is the raw or the cooked weight ("raw", "cooked", or "na"',
  'if the distinction is meaningless, e.g. for fruit or a drink).',
  'Use plain generic ingredient names (e.g. "white rice", "chicken breast", "olive oil")',
  'so they can be matched against a food database. Include cooking oil and sauces',
  'when they are likely present, since they carry real calories.',
  'Reply ONLY with JSON of the form:',
  '{"name": string (short meal name, max 40 chars),',
  ' "ingredients": [{"name": string, "grams": number, "state": "raw"|"cooked"|"na",',
  '   "calories": number, "protein": number, "carbs": number, "fat": number}],',
  ' "confidence": "low"|"medium"|"high"}',
  'Macros are for that ingredient at that weight, in grams.',
  'If a photo is given, estimate portion sizes from visual cues.',
  'If both text and photo are given, the text takes priority for portions.',
].join(' ');

// Find the best foods-table match for a loose ingredient name.
async function matchFood(rawName) {
  const name = str(rawName).trim().toLowerCase();
  if (!name) return null;
  const exact = await db.get('SELECT * FROM foods WHERE lower(name) = ? LIMIT 1', [name]);
  if (exact) return exact;
  // Prefer a name that starts with the term, then the shortest containing match —
  // "rice" should land on "White rice, cooked", not "Rice cake with peanut butter".
  /* Ranking matters more than it looks. For "egg", both "Egg, whole, cooked" and
     "Egg white, cooked" match, and plain length ordering picks the white — the wrong
     answer. A comma straight after the term marks the base food; another word marks a
     variant. So: "term," beats "term ", which beats "term…", which beats a mid-string
     hit, with the shortest name breaking ties. */
  const rank = `CASE
      WHEN lower(name) = ?    THEN 0
      WHEN lower(name) LIKE ? THEN 1
      WHEN lower(name) LIKE ? THEN 2
      WHEN lower(name) LIKE ? THEN 3
      ELSE 4 END`;
  // Fewer words means a more generic entry: "Egg, whole, cooked" (3) should win over
  // "Egg, fried in oil" (4), even though the latter is a shorter string.
  const words = `(length(name) - length(replace(name, ' ', '')))`;
  const hit = await db.get(
    `SELECT * FROM foods WHERE lower(name) LIKE ? ORDER BY ${rank}, ${words}, length(name) LIMIT 1`,
    [`%${name}%`, name, `${name},%`, `${name} %`, `${name}%`]);
  if (hit) return hit;
  // People type plurals ("eggs", "strawberries"); the database is singular.
  // Try the singular form before giving up — this is a spelling variation of the
  // same word, not a loose semantic guess, so it can't mismatch the way the old
  // shared-word fallback did.
  const singular = /ies$/i.test(name) ? name.replace(/ies$/i, 'y')
    : /(ses|xes|zes|ches|shes)$/i.test(name) ? name.replace(/es$/i, '')
    : /[^s]s$/i.test(name) ? name.replace(/s$/i, '')
    : null;
  if (singular && singular.length > 2) {
    const alt = await db.get(
      `SELECT * FROM foods WHERE lower(name) LIKE ? ORDER BY ${rank}, ${words}, length(name) LIMIT 1`,
      [`%${singular}%`, singular, `${singular},%`, `${singular} %`, `${singular}%`]);
    if (alt) return alt;
  }
  // Deliberately no looser fallback than this. An earlier version matched on any
  // shared word, which mapped "unobtainium flakes" onto "Cereal, corn flakes" and
  // silently logged the wrong food. Returning null is better: the ingredient keeps
  // the model's own estimate, is labelled as an estimate in the UI, and stays editable.
  return null;
}

route('POST', /^\/api\/ai\/estimate$/, async (req, res) => {
  if (!process.env.GEMINI_API_KEY) return send(res, 400, { error: 'AI is not configured' });
  const b = await readBody(req);
  const parts = [];
  if (str(b.text).trim()) parts.push({ text: 'Meal description: ' + str(b.text).trim() });
  if (b.photoData) {
    const m = /^data:image\/(png|jpe?g|webp);base64,(.+)$/.exec(b.photoData);
    if (m) parts.push({ inline_data: { mime_type: `image/${m[1] === 'jpg' ? 'jpeg' : m[1]}`, data: m[2] } });
  }
  if (!parts.length) return send(res, 400, { error: 'Describe the meal or attach a photo' });
  const base = process.env.GEMINI_URL || 'https://generativelanguage.googleapis.com';
  const model = process.env.GEMINI_MODEL || 'gemini-flash-latest';

  let r;
  try {
    r = await fetch(`${base}/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts }],
        systemInstruction: { parts: [{ text: AI_SYSTEM }] },
        generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
      }),
    });
  } catch { return send(res, 502, { error: 'Could not reach the AI service' }); }
  if (!r.ok) return send(res, 502, { error: `AI request failed (${r.status})` });
  const j = await r.json();
  let out;
  try { out = JSON.parse(j.candidates[0].content.parts[0].text); }
  catch { return send(res, 502, { error: 'AI returned an unexpected format' }); }

  const rawList = Array.isArray(out.ingredients) ? out.ingredients.slice(0, 20) : [];
  const ingredients = [];
  for (const ing of rawList) {
    const grams = Math.max(0, num(ing.grams));
    const state = ['raw', 'cooked'].includes(ing.state) ? ing.state : 'na';
    const food = await matchFood(ing.name);
    if (food && grams > 0) {
      // We have this food for real — recompute from our per-100g data, converting
      // between raw and cooked weight if the states differ and we know the yield.
      const g = convertGrams(grams, state, food);
      const k = g / 100;
      ingredients.push({
        name: food.name, foodId: food.id, grams: Math.round(grams), state,
        calories: Math.round(food.kcal * k), protein: round1s(food.protein * k),
        carbs: round1s(food.carbs * k), fat: round1s(food.fat * k),
        source: 'db', matched: true,
        foodState: food.state, yieldFactor: food.yield_factor,
      });
    } else {
      ingredients.push({
        name: str(ing.name).slice(0, 60) || 'Ingredient', foodId: null,
        grams: Math.round(grams), state,
        calories: Math.round(num(ing.calories)), protein: round1s(ing.protein),
        carbs: round1s(ing.carbs), fat: round1s(ing.fat),
        source: 'ai', matched: false,
      });
    }
  }

  const sum = (k) => ingredients.reduce((a, i) => a + num(i[k]), 0);
  const totals = ingredients.length
    ? { calories: Math.round(sum('calories')), protein: round1s(sum('protein')), carbs: round1s(sum('carbs')), fat: round1s(sum('fat')) }
    : { calories: num(out.calories), protein: num(out.protein), carbs: num(out.carbs), fat: num(out.fat) };

  send(res, 200, {
    name: str(out.name).slice(0, 60),
    confidence: str(out.confidence, 'medium'),
    ingredients,
    matchedCount: ingredients.filter((i) => i.matched).length,
    ...totals,
  });
});

/* ---------------- free-text meal parsing ----------------
   The fastest way to log a meal is to type it the way you'd say it:

       Fried chicken tonkatsu
       400g chicken breast cooked
       50g mayo
       2 tbsp panko

   The first line without a quantity becomes the meal name; every other line is
   parsed into quantity + unit + food + cooked/raw state, matched against the food
   database, and costed from real per-100 g data. Only the lines we genuinely
   cannot match are handed to the AI, so a typical meal costs zero AI calls. */

const UNIT_ALIASES = {
  g: 'g', gram: 'g', grams: 'g', gr: 'g',
  kg: 'kg', kilo: 'kg', kilos: 'kg', kilogram: 'kg', kilograms: 'kg',
  oz: 'oz', ounce: 'oz', ounces: 'oz',
  lb: 'lb', lbs: 'lb', pound: 'lb', pounds: 'lb',
  ml: 'ml', milliliter: 'ml', millilitre: 'ml', milliliters: 'ml', millilitres: 'ml',
  l: 'l', liter: 'l', litre: 'l', liters: 'l', litres: 'l',
  cup: 'cup', cups: 'cup',
  tbsp: 'tbsp', tablespoon: 'tbsp', tablespoons: 'tbsp', tbs: 'tbsp',
  tsp: 'tsp', teaspoon: 'tsp', teaspoons: 'tsp',
  piece: 'piece', pieces: 'piece', pc: 'piece', pcs: 'piece',
  slice: 'slice', slices: 'slice',
  scoop: 'scoop', scoops: 'scoop',
  serving: 'serving', servings: 'serving', portion: 'serving', portions: 'serving',
};

// Weight/volume units we can convert without knowing the food.
const ABSOLUTE_GRAMS = { g: 1, kg: 1000, oz: 28.35, lb: 453.6, ml: 1, l: 1000 };
// Household measures — rough, and only used when the food has no portion of its own.
const HOUSEHOLD_GRAMS = { cup: 240, tbsp: 15, tsp: 5, piece: 100, slice: 30, scoop: 30, serving: 100 };

const UNIT_WORDS = Object.keys(UNIT_ALIASES).sort((a, b) => b.length - a.length).join('|');
// "400g chicken breast", "2 tbsp mayo", "1.5 cups rice"
const LEADING_QTY = new RegExp(`^(\\d+(?:[.,]\\d+)?)\\s*(${UNIT_WORDS})?\\b\\.?\\s*(?:of\\s+)?(.+)$`, 'i');
// "chicken breast 400g", "mayo 50 g", and bare "chicken breast 250" (grams implied).
// The name must end in a letter or bracket and be followed by real whitespace, so
// ratio-style names keep working: in "Ground beef 80/20" the trailing 20 is preceded
// by "/" rather than a space, so it is not mistaken for a quantity.
const TRAILING_QTY = new RegExp(`^(.+?[a-z%)\\]])\\s+(\\d+(?:[.,]\\d+)?)\\s*(${UNIT_WORDS})?\\s*\\.?$`, 'i');
const STATE_RE = /\b(cooked|uncooked|raw|dry|dried)\b/i;
// Noise people naturally type that isn't part of a food name.
const STRIP_RE = /^(?:\s*[-*•·]\s*|\s*\d+[.)]\s*)/;

function parseLine(line) {
  let text = line.replace(STRIP_RE, '').trim();
  if (!text) return null;

  let qty = null, unit = null, name = text;

  let m = LEADING_QTY.exec(text);
  if (m) {
    qty = parseFloat(m[1].replace(',', '.'));
    unit = m[2] ? UNIT_ALIASES[m[2].toLowerCase()] : null;
    name = m[3];
  } else {
    m = TRAILING_QTY.exec(text);
    if (m) {
      name = m[1];
      qty = parseFloat(m[2].replace(',', '.'));
      unit = m[3] ? UNIT_ALIASES[m[3].toLowerCase()] : null;
    }
  }

  // Cooked/raw can appear anywhere in the line; pull it out of the food name.
  let state = 'na';
  const sm = STATE_RE.exec(name);
  if (sm) {
    const word = sm[1].toLowerCase();
    state = (word === 'cooked') ? 'cooked' : 'raw';
    name = (name.slice(0, sm.index) + ' ' + name.slice(sm.index + sm[1].length)).trim();
  }

  name = name.replace(/[,;]+$/, '').replace(/\s{2,}/g, ' ').trim();
  if (!name) return null;
  return { qty, unit, name, state, raw: line.trim() };
}

// Turn a parsed quantity into grams of the matched food.
function toGrams(parsed, food) {
  const { qty, unit } = parsed;
  if (qty == null) {
    // No quantity given — fall back to the food's own portion, else 100 g,
    // and flag it so the UI can say the amount was assumed.
    return { grams: (food && food.portion_grams) || 100, assumed: true };
  }
  if (!unit) {
    /* A bare number is usually grams ("chicken breast 250"), but "3 eggs" means
       three of them, not three grams. Small counts against a food that has a known
       portion weight are read as counts; anything above the threshold, or a food we
       have no portion for, stays grams. Nobody eats 3 g of a whole food, and nobody
       counts out 250 of one, so the two cases don't overlap in practice. */
    const COUNT_MAX = 20;
    if (qty <= COUNT_MAX && food && food.portion_grams) {
      const per = food.portion_grams / (parseFloat((food.portion_name || '')) || 1);
      return { grams: qty * per, assumed: false, readAsCount: true };
    }
    return { grams: qty, assumed: false };
  }
  if (ABSOLUTE_GRAMS[unit]) return { grams: qty * ABSOLUTE_GRAMS[unit], assumed: false };

  // Household measure: prefer the food's own portion, since "1 cup rice" is 158 g of
  // cooked rice rather than a generic 240 g, and an egg is ~50 g rather than 100 g.
  // portion_name usually leads with a count ("6 pieces", "1 large"), so divide the
  // portion weight by that count to get the weight of a single unit.
  const COUNTABLE = new Set(['piece', 'slice', 'scoop', 'serving']);
  if (food && food.portion_grams) {
    const pn = (food.portion_name || '').toLowerCase();
    if (pn.includes(unit) || COUNTABLE.has(unit)) {
      const per = food.portion_grams / (parseFloat(pn) || 1);
      return { grams: qty * per, assumed: false };
    }
  }
  return { grams: qty * (HOUSEHOLD_GRAMS[unit] || 100), assumed: !food };
}

route('POST', /^\/api\/parse-meal$/, async (req, res) => {
  const b = await readBody(req);
  const text = str(b.text, '');
  if (!text.trim()) return send(res, 400, { error: 'Type your meal first' });

  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 40);
  if (!lines.length) return send(res, 400, { error: 'Type your meal first' });

  let mealName = str(b.name, '').trim();
  const parsed = [];
  for (let i = 0; i < lines.length; i++) {
    const p = parseLine(lines[i]);
    if (!p) continue;
    // A first line with no quantity is the meal's name, not an ingredient.
    if (i === 0 && p.qty == null && lines.length > 1 && !mealName) {
      mealName = p.name;
      continue;
    }
    parsed.push(p);
  }

  const items = [];
  const unresolved = [];
  for (const p of parsed) {
    const food = await matchFood(p.name);
    if (food) {
      const { grams, assumed } = toGrams(p, food);
      // If the line didn't say cooked/raw, use the food's own state so we don't
      // apply a conversion the user never asked for.
      const state = p.state !== 'na' ? p.state : (food.state !== 'na' ? food.state : 'na');
      const k = convertGrams(grams, state, food) / 100;
      items.push({
        name: food.name, foodId: food.id, grams: Math.round(grams),
        state, source: 'db', matched: true, assumedAmount: assumed,
        calories: Math.round(food.kcal * k), protein: round1s(food.protein * k),
        carbs: round1s(food.carbs * k), fat: round1s(food.fat * k),
        foodState: food.state, yieldFactor: food.yield_factor,
        typed: p.raw,
      });
    } else {
      const { grams } = toGrams(p, null);
      const row = {
        name: p.name, foodId: null, grams: Math.round(grams), state: p.state,
        source: 'manual', matched: false, assumedAmount: p.qty == null,
        calories: 0, protein: 0, carbs: 0, fat: 0, typed: p.raw,
      };
      items.push(row);
      unresolved.push({ index: items.length - 1, name: p.name, grams: row.grams, state: p.state });
    }
  }

  /* Anything the database didn't know goes to the AI in ONE batched call —
     not one call per ingredient — and only if a key is configured. */
  let aiUsed = false;
  if (unresolved.length && process.env.GEMINI_API_KEY && b.useAI !== false) {
    try {
      const list = unresolved.map((u) => `${u.grams} g ${u.name}${u.state !== 'na' ? ` (${u.state})` : ''}`).join('\n');
      const base = process.env.GEMINI_URL || 'https://generativelanguage.googleapis.com';
      const model = process.env.GEMINI_MODEL || 'gemini-flash-latest';
      const r = await fetch(`${base}/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: 'Foods:\n' + list }] }],
          systemInstruction: { parts: [{ text:
            'You are a nutrition estimator. For EACH food line given, estimate the macros for exactly the stated weight. ' +
            'Reply ONLY with JSON: {"items":[{"calories":number,"protein":number,"carbs":number,"fat":number}]} ' +
            'with one entry per input line, in the same order. Values are grams except calories (kcal).' }] },
          generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
        }),
      });
      if (r.ok) {
        const j = await r.json();
        const out = JSON.parse(j.candidates[0].content.parts[0].text);
        const arr = Array.isArray(out.items) ? out.items : [];
        unresolved.forEach((u, n) => {
          const est = arr[n];
          if (!est) return;
          const it = items[u.index];
          it.calories = Math.round(num(est.calories));
          it.protein = round1s(est.protein);
          it.carbs = round1s(est.carbs);
          it.fat = round1s(est.fat);
          it.source = 'ai';
          aiUsed = true;
        });
      }
    } catch (err) {
      console.error('parse-meal AI step failed:', err.message);
    }
  }

  const sum = (k) => items.reduce((a, i) => a + num(i[k]), 0);
  send(res, 200, {
    name: mealName,
    items,
    matchedCount: items.filter((i) => i.matched).length,
    aiCount: items.filter((i) => i.source === 'ai').length,
    unknownCount: items.filter((i) => !i.matched && i.source !== 'ai').length,
    aiUsed,
    calories: Math.round(sum('calories')), protein: round1s(sum('protein')),
    carbs: round1s(sum('carbs')), fat: round1s(sum('fat')),
  });
});

// --- exercise library ---
route('GET', /^\/api\/exercise-lib$/, async (req, res, q) => {
  const query = str(q.get('q'), '').trim().toLowerCase();
  const muscle = str(q.get('muscle'), '').trim().toLowerCase();
  let rows;
  if (query) {
    rows = await db.all(
      `SELECT * FROM exercise_lib WHERE lower(name) LIKE ? ${muscle ? 'AND muscle = ?' : ''}
       ORDER BY CASE WHEN lower(name) LIKE ? THEN 0 ELSE 1 END, name LIMIT 30`,
      muscle ? [`%${query}%`, muscle, `${query}%`] : [`%${query}%`, `${query}%`]);
  } else if (muscle) {
    rows = await db.all('SELECT * FROM exercise_lib WHERE muscle = ? ORDER BY name', [muscle]);
  } else {
    rows = await db.all('SELECT * FROM exercise_lib ORDER BY name');
  }
  send(res, 200, rows);
});

// --- "last time" memory + PR for an exercise ---
route('GET', /^\/api\/exercise-last$/, async (req, res, q) => {
  const userId = num(q.get('user'));
  const name = str(q.get('name'), '').trim();
  if (!name) return send(res, 400, { error: 'name required' });
  const lastEx = await db.get(
    `SELECT e.id, w.date FROM exercises e JOIN workouts w ON w.id = e.workout_id
     WHERE w.user_id = ? AND e.name = ? ORDER BY w.date DESC, w.id DESC LIMIT 1`, [userId, name]);
  const lastSets = lastEx
    ? await db.all('SELECT reps, weight, set_type FROM sets WHERE exercise_id = ? ORDER BY position, id', [lastEx.id])
    : [];
  const pr = await db.get(
    `SELECT MAX(s.weight) AS max_weight, MAX(s.weight * (1 + s.reps / 30.0)) AS best_1rm
     FROM sets s JOIN exercises e ON e.id = s.exercise_id JOIN workouts w ON w.id = e.workout_id
     WHERE w.user_id = ? AND e.name = ? AND s.reps > 0`, [userId, name]);
  send(res, 200, { lastDate: lastEx ? lastEx.date : null, lastSets, pr: pr || {} });
});

// --- per-exercise history (for charts) ---
route('GET', /^\/api\/exercise-history$/, async (req, res, q) => {
  const userId = num(q.get('user'));
  const name = str(q.get('name'), '').trim();
  const rows = await db.all(
    `SELECT w.date, MAX(s.weight) AS top_weight, MAX(s.weight * (1 + s.reps / 30.0)) AS est_1rm,
            SUM(s.weight * s.reps) AS volume
     FROM sets s JOIN exercises e ON e.id = s.exercise_id JOIN workouts w ON w.id = e.workout_id
     WHERE w.user_id = ? AND e.name = ? AND s.reps > 0
     GROUP BY w.date, w.id ORDER BY w.date`, [userId, name]);
  const names = await db.all(
    `SELECT e.name, COUNT(*) AS n FROM exercises e JOIN workouts w ON w.id = e.workout_id
     WHERE w.user_id = ? GROUP BY e.name ORDER BY n DESC LIMIT 40`, [userId]);
  send(res, 200, { history: rows, exercises: names.map((r) => r.name) });
});

// --- muscle-group volume split ---
route('GET', /^\/api\/muscle-split$/, async (req, res, q) => {
  const userId = num(q.get('user'));
  const days = Math.min(Math.max(num(q.get('days'), 30), 7), 365);
  const from = addDays(today(), -(days - 1));
  const rows = await db.all(
    `SELECT COALESCE(l.muscle, 'other') AS muscle, COUNT(s.id) AS sets
     FROM sets s JOIN exercises e ON e.id = s.exercise_id JOIN workouts w ON w.id = e.workout_id
     LEFT JOIN exercise_lib l ON l.name = e.name
     WHERE w.user_id = ? AND w.date >= ? GROUP BY COALESCE(l.muscle, 'other') ORDER BY sets DESC`, [userId, from]);
  send(res, 200, rows);
});

// --- routines (workout templates) ---
route('GET', /^\/api\/routines$/, async (req, res, q) => {
  const userId = num(q.get('user'));
  const routines = await db.all('SELECT * FROM routines WHERE user_id = ? ORDER BY id', [userId]);
  const ids = routines.map((r) => r.id);
  const items = ids.length
    ? await db.all(`SELECT * FROM routine_items WHERE routine_id IN (${placeholders(ids)}) ORDER BY position, id`, ids)
    : [];
  send(res, 200, routines.map((r) => ({ ...r, items: items.filter((i) => i.routine_id === r.id) })));
});
route('POST', /^\/api\/routines$/, async (req, res) => {
  const b = await readBody(req);
  if (!str(b.title).trim()) return send(res, 400, { error: 'title required' });
  const info = await db.run('INSERT INTO routines (user_id, title) VALUES (?, ?)', [num(b.userId), str(b.title).trim().slice(0, 60)]);
  let i = 0;
  for (const item of Array.isArray(b.items) ? b.items : []) {
    if (!str(item.exercise).trim()) continue;
    await db.run('INSERT INTO routine_items (routine_id, exercise, sets, position) VALUES (?, ?, ?, ?)',
      [info.lastInsertRowid, str(item.exercise).trim(), Math.max(1, num(item.sets, 3)), i++]);
  }
  send(res, 201, { id: info.lastInsertRowid });
});
route('DELETE', /^\/api\/routines\/(\d+)$/, async (req, res, q, m) => {
  await db.run('DELETE FROM routine_items WHERE routine_id = ?', [num(m[1])]);
  await db.run('DELETE FROM routines WHERE id = ?', [num(m[1])]);
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
/* ---------------- weekly recap ----------------
   Computed for a Monday–Sunday week in the app timezone. The recap is generated
   once per user per week and stored, so the numbers a push mentions are exactly
   the numbers the card shows, and re-opening the app doesn't silently change them.

   Nothing here is scheduled inside the process: the Render free tier sleeps after
   15 idle minutes, so an in-process timer would simply not fire on a Sunday night.
   Generation is triggered two ways instead — an external ping (a free GitHub
   Actions cron) and, as a backstop, lazily whenever the app is opened and last
   week's recap is missing. Worst case the push is late; the card is never absent. */

const PRIOR_WEEKS = 8; // history used for "best week" comparisons

// Epley — same formula the Strength chart already uses, so numbers agree.
const e1rm = (weight, reps) => (reps > 0 ? weight * (1 + reps / 30) : 0);

async function buildRecap(userId, weekStart) {
  const weekEnd = addDays(weekStart, 6);
  const prevStart = addDays(weekStart, -7);
  const prevEnd = addDays(weekStart, -1);

  const [goals, user, mealDaily, prevMealDaily, workouts, restDays, weights, prevWeights, histStart] = await Promise.all([
    getGoals(userId),
    db.get('SELECT * FROM users WHERE id = ?', [userId]),
    db.all(
      `SELECT date, SUM(calories) AS calories, SUM(protein) AS protein, SUM(carbs) AS carbs,
              SUM(fat) AS fat, COUNT(*) AS meals
       FROM meals WHERE user_id = ? AND date >= ? AND date <= ? GROUP BY date ORDER BY date`,
      [userId, weekStart, weekEnd]),
    db.all(
      `SELECT SUM(calories) AS calories, SUM(protein) AS protein, COUNT(DISTINCT date) AS days
       FROM meals WHERE user_id = ? AND date >= ? AND date <= ?`, [userId, prevStart, prevEnd]),
    db.all('SELECT * FROM workouts WHERE user_id = ? AND date >= ? AND date <= ? ORDER BY date', [userId, weekStart, weekEnd]),
    db.all('SELECT date FROM rest_days WHERE user_id = ? AND date >= ? AND date <= ?', [userId, weekStart, weekEnd]),
    db.all('SELECT date, kg FROM weights WHERE user_id = ? AND date >= ? AND date <= ? ORDER BY date', [userId, weekStart, weekEnd]),
    db.all('SELECT date, kg FROM weights WHERE user_id = ? AND date < ? ORDER BY date DESC LIMIT 1', [userId, weekStart]),
    Promise.resolve(addDays(weekStart, -7 * PRIOR_WEEKS)),
  ]);

  /* ---- days ---- */
  const mealMap = new Map(mealDaily.map((r) => [r.date, r]));
  const woDates = new Set(workouts.map((w) => w.date));
  const restSet = new Set(restDays.map((r) => r.date));
  const todayStr = today();
  const days = [];
  for (let d = weekStart; d <= weekEnd; d = addDays(d, 1)) {
    const m = mealMap.get(d);
    days.push({
      date: d,
      future: d > todayStr,
      calories: m ? Math.round(m.calories) : 0,
      protein: m ? round1s(m.protein) : 0,
      carbs: m ? round1s(m.carbs) : 0,
      fat: m ? round1s(m.fat) : 0,
      meals: m ? m.meals : 0,
      trained: woDates.has(d),
      rest: restSet.has(d),
      logged: !!(m && m.meals > 0),
    });
  }
  const past = days.filter((d) => !d.future);
  const loggedDays = past.filter((d) => d.logged);
  const nLogged = loggedDays.length || 0;

  /* ---- macros vs targets ----
     Averages are over days actually logged, not over 7, so a week with three
     untracked days isn't reported as if the person ate nothing on them. The
     untracked count is reported separately and honestly. */
  const avg = (k) => (nLogged ? loggedDays.reduce((a, d) => a + d[k], 0) / nLogged : 0);
  const macros = ['calories', 'protein', 'carbs', 'fat'].map((k) => {
    const target = k === 'calories' ? goals.calories : goals[k];
    const average = avg(k);
    const diff = average - target;
    return {
      key: k,
      label: k === 'calories' ? 'Calories' : k[0].toUpperCase() + k.slice(1),
      avg: k === 'calories' ? Math.round(average) : round1s(average),
      target,
      diff: k === 'calories' ? Math.round(diff) : round1s(diff),
      pct: target ? Math.round((average / target) * 100) : 0,
      unit: k === 'calories' ? 'kcal' : 'g',
    };
  });

  /* ---- workouts ---- */
  const workoutIds = workouts.map((w) => w.id);
  let sets = [];
  if (workoutIds.length) {
    sets = await db.all(
      `SELECT s.reps, s.weight, s.set_type, e.name AS exercise, w.date
       FROM sets s
       JOIN exercises e ON e.id = s.exercise_id
       JOIN workouts w ON w.id = e.workout_id
       WHERE w.id IN (${placeholders(workoutIds)})`, workoutIds);
  }
  const workingSets = sets.filter((s) => s.set_type !== 'warmup');
  const volume = workingSets.reduce((a, s) => a + num(s.reps) * num(s.weight), 0);

  // Muscle split for the week, via the exercise library.
  let muscles = [];
  if (workingSets.length) {
    const names = [...new Set(workingSets.map((s) => s.exercise.toLowerCase()))];
    const lib = await db.all(
      `SELECT lower(name) AS lname, muscle FROM exercise_lib WHERE lower(name) IN (${placeholders(names)})`, names);
    const byName = new Map(lib.map((r) => [r.lname, r.muscle]));
    const counts = new Map();
    for (const s of workingSets) {
      const mus = byName.get(s.exercise.toLowerCase()) || 'other';
      counts.set(mus, (counts.get(mus) || 0) + 1);
    }
    muscles = [...counts.entries()].map(([muscle, setCount]) => ({ muscle, sets: setCount }))
      .sort((a, b) => b.sets - a.sets);
  }

  /* ---- personal records ----
     A PR is a top-set e1RM for an exercise that beats everything logged for it
     before this week. Comparing against history rather than within the week is
     what makes it a record instead of just a good day. */
  const prs = [];
  if (workingSets.length) {
    const bestThisWeek = new Map();
    for (const s of workingSets) {
      const v = e1rm(num(s.weight), num(s.reps));
      if (!v) continue;
      const cur = bestThisWeek.get(s.exercise);
      if (!cur || v > cur.e1rm) bestThisWeek.set(s.exercise, { e1rm: v, weight: num(s.weight), reps: num(s.reps), date: s.date });
    }
    const exNames = [...bestThisWeek.keys()];
    if (exNames.length) {
      const priorRows = await db.all(
        `SELECT e.name AS exercise, s.reps, s.weight
         FROM sets s
         JOIN exercises e ON e.id = s.exercise_id
         JOIN workouts w ON w.id = e.workout_id
         WHERE w.user_id = ? AND w.date < ? AND s.set_type != 'warmup'
           AND lower(e.name) IN (${placeholders(exNames.map((n) => n.toLowerCase()))})`,
        [userId, weekStart, ...exNames.map((n) => n.toLowerCase())]);
      const priorBest = new Map();
      for (const r of priorRows) {
        const v = e1rm(num(r.weight), num(r.reps));
        const key = r.exercise.toLowerCase();
        if (!priorBest.has(key) || v > priorBest.get(key)) priorBest.set(key, v);
      }
      for (const [exercise, best] of bestThisWeek) {
        const prev = priorBest.get(exercise.toLowerCase()) || 0;
        if (best.e1rm > prev + 0.01) {
          prs.push({
            exercise, weight: best.weight, reps: best.reps,
            e1rm: round1s(best.e1rm), prev: round1s(prev),
            gain: prev ? round1s(best.e1rm - prev) : null,
            first: !prev,
          });
        }
      }
      prs.sort((a, b) => (b.gain || 0) - (a.gain || 0));
    }
  }

  /* ---- weight ---- */
  const startKg = prevWeights[0]?.kg ?? weights[0]?.kg ?? null;
  const endKg = weights.length ? weights[weights.length - 1].kg : null;
  const weightChange = startKg != null && endKg != null ? round1s(endKg - startKg) : null;

  /* ---- misses ---- */
  const missedLogging = past.filter((d) => !d.logged).map((d) => d.date);
  const noActivity = past.filter((d) => !d.trained && !d.rest).map((d) => d.date);
  const workoutTarget = goals.workouts_per_week || 0;
  const workoutCount = woDates.size;

  /* ---- streak + previous week comparison ---- */
  const streakNow = await streak(userId, todayStr);
  const prev = prevMealDaily[0] || {};
  const prevDays = num(prev.days);
  const prevAvgCal = prevDays ? Math.round(num(prev.calories) / prevDays) : null;
  const prevAvgPro = prevDays ? round1s(num(prev.protein) / prevDays) : null;

  return {
    userId, name: user?.name || `User ${userId}`,
    weekStart, weekEnd,
    daysLogged: nLogged, daysElapsed: past.length,
    days,
    goals: {
      calories: goals.calories, protein: goals.protein, carbs: goals.carbs, fat: goals.fat,
      workoutsPerWeek: workoutTarget,
    },
    macros,
    totals: {
      calories: Math.round(past.reduce((a, d) => a + d.calories, 0)),
      protein: round1s(past.reduce((a, d) => a + d.protein, 0)),
      carbs: round1s(past.reduce((a, d) => a + d.carbs, 0)),
      fat: round1s(past.reduce((a, d) => a + d.fat, 0)),
      meals: past.reduce((a, d) => a + d.meals, 0),
    },
    workouts: {
      count: workoutCount, target: workoutTarget,
      hitTarget: workoutTarget ? workoutCount >= workoutTarget : null,
      sets: workingSets.length,
      volume: Math.round(volume),
      restDays: restSet.size,
      muscles,
      dates: [...woDates].sort(),
    },
    prs,
    weight: { start: startKg, end: endKg, change: weightChange },
    missed: { logging: missedLogging, activity: noActivity },
    streak: streakNow,
    vsLastWeek: { avgCalories: prevAvgCal, avgProtein: prevAvgPro },
  };
}

/* Headline sentences. Kept on the server so the push text and the card text are
   generated from one place and can never disagree. */
function recapHeadlines(r) {
  const out = [];
  const protein = r.macros.find((m) => m.key === 'protein');
  const cals = r.macros.find((m) => m.key === 'calories');

  if (r.daysLogged === 0) {
    out.push('No meals logged this week — nothing to measure yet.');
  } else {
    if (protein && protein.target) {
      out.push(protein.diff >= 0
        ? `Protein averaged ${protein.avg} g — ${protein.diff} g over your ${protein.target} g target.`
        : `Protein averaged ${protein.avg} g, ${Math.abs(protein.diff)} g short of ${protein.target} g.`);
    }
    if (cals && cals.target) {
      out.push(`Calories averaged ${cals.avg} vs a ${cals.target} target (${cals.diff >= 0 ? '+' : ''}${cals.diff}).`);
    }
  }
  if (r.workouts.target) {
    out.push(r.workouts.hitTarget
      ? `${r.workouts.count} of ${r.workouts.target} workouts — target hit.`
      : `${r.workouts.count} of ${r.workouts.target} workouts.`);
  } else if (r.workouts.count) {
    out.push(`${r.workouts.count} workouts logged.`);
  }
  if (r.prs.length) {
    const top = r.prs[0];
    out.push(r.prs.length === 1
      ? `New PR: ${top.exercise} ${top.weight} × ${top.reps}.`
      : `${r.prs.length} new PRs, best on ${top.exercise} (${top.weight} × ${top.reps}).`);
  }
  if (r.weight.change != null && Math.abs(r.weight.change) >= 0.1) {
    out.push(`Weight ${r.weight.change > 0 ? 'up' : 'down'} ${Math.abs(r.weight.change)} kg.`);
  }
  if (r.missed.logging.length) {
    out.push(`${r.missed.logging.length} day${r.missed.logging.length > 1 ? 's' : ''} without a meal logged.`);
  }
  return out;
}

// Generate (or fetch) both users' recaps for a week, storing them once.
async function getOrBuildRecaps(weekStart, { force = false } = {}) {
  const users = await db.all('SELECT id FROM users ORDER BY id');
  const out = [];
  for (const u of users) {
    const row = await db.get('SELECT * FROM recaps WHERE user_id = ? AND week_start = ?', [u.id, weekStart]);
    if (row && !force) { out.push({ ...JSON.parse(row.payload), _stored: true, _pushed: !!row.pushed }); continue; }
    const r = await buildRecap(u.id, weekStart);
    r.headlines = recapHeadlines(r);
    const payload = JSON.stringify(r);
    if (row) await db.run('UPDATE recaps SET payload = ?, created_at = ? WHERE id = ?', [payload, new Date().toISOString(), row.id]);
    else await db.run('INSERT INTO recaps (user_id, week_start, payload, created_at) VALUES (?, ?, ?, ?)',
      [u.id, weekStart, payload, new Date().toISOString()]);
    out.push({ ...r, _stored: false, _pushed: row ? !!row.pushed : false });
  }
  return out;
}

/* ---- routes ---- */

// The most recently COMPLETED week (Monday of last week).
const lastCompletedWeek = () => addDays(mondayOf(today()), -7);

route('GET', /^\/api\/recap$/, async (req, res, q) => {
  const week = isDate(q.get('week')) ? mondayOf(q.get('week')) : lastCompletedWeek();
  const recaps = await getOrBuildRecaps(week, { force: q.get('force') === '1' });
  send(res, 200, { weekStart: week, weekEnd: addDays(week, 6), recaps });
});

// Mark a recap as seen so the card stops taking over the Today tab.
route('POST', /^\/api\/recap\/seen$/, async (req, res) => {
  const b = await readBody(req);
  const week = isDate(b.week) ? b.week : lastCompletedWeek();
  await db.run('UPDATE recaps SET seen = 1 WHERE user_id = ? AND week_start = ?', [num(b.userId), week]);
  send(res, 200, { ok: true });
});

/* Fired by an external scheduler (free GitHub Actions cron). Builds last week's
   recap and pushes it once. Safe to call repeatedly — pushes are only sent for
   recaps not already marked pushed, so a retry or a double-fire won't spam. */
route('POST', /^\/api\/recap\/run$/, async (req, res) => {
  const b = await readBody(req).catch(() => ({}));
  const secret = process.env.RECAP_SECRET || '';
  if (secret && str(b.key) !== secret) return send(res, 403, { error: 'Forbidden' });
  const week = isDate(b.week) ? mondayOf(b.week) : lastCompletedWeek();
  const recaps = await getOrBuildRecaps(week, { force: !!b.force });
  let pushed = 0, delivered = 0;
  for (const r of recaps) {
    const row = await db.get('SELECT * FROM recaps WHERE user_id = ? AND week_start = ?', [r.userId, week]);
    if (!row || (row.pushed && !b.force)) continue;
    const head = (r.headlines || []).slice(0, 2).join(' ');
    delivered += await notifyUser(r.userId, {
      title: `Your week: ${fmtShort(week)}–${fmtShort(addDays(week, 6))}`,
      body: head || 'Your weekly recap is ready.',
      tag: `recap-${week}`,
      url: '/?recap=' + week,
    });
    await db.run('UPDATE recaps SET pushed = 1 WHERE id = ?', [row.id]);
    pushed++;
  }
  send(res, 200, { ok: true, weekStart: week, users: recaps.length, pushed, delivered });
});

const fmtShort = (d) => {
  const [, m, day] = d.split('-');
  return `${['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m)]} ${Number(day)}`;
};

route('GET', /^\/api\/health$/, async (req, res) => send(res, 200, { ok: true, driver: db.driverName, ai: !!process.env.GEMINI_API_KEY }));

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

db.init().then(ensureVapid).then(() => {
  server.listen(PORT, () => console.log(`Accountable running → http://localhost:${PORT}`));
}).catch((err) => {
  console.error('Storage init failed:', err.message);
  process.exit(1);
});
