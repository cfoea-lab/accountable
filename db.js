// db.js — async storage layer with two interchangeable drivers:
//   • local:  built-in node:sqlite file database (default — laptop/home use)
//   • turso:  hosted libSQL over HTTP (set TURSO_URL + TURSO_TOKEN — used on Render,
//             whose free tier has an ephemeral filesystem)
// Photos are stored IN the database (base64), so nothing depends on local disk in prod.
'use strict';
const path = require('node:path');
const fs = require('node:fs');

const TURSO_URL = process.env.TURSO_URL || '';
const TURSO_TOKEN = process.env.TURSO_TOKEN || '';

/* ---------------- drivers ---------------- */
// Both expose: exec(sql, params) -> { rows: [obj], lastInsertRowid, rowsAffected }

function localDriver() {
  const { DatabaseSync } = require('node:sqlite');
  const DATA_DIR = path.join(__dirname, 'data');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(path.join(DATA_DIR, 'accountable.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  return {
    name: 'local',
    async exec(sql, params = []) {
      const stmt = db.prepare(sql);
      if (/^\s*(SELECT|WITH|PRAGMA)/i.test(sql)) {
        return { rows: stmt.all(...params), lastInsertRowid: 0, rowsAffected: 0 };
      }
      const info = stmt.run(...params);
      return { rows: [], lastInsertRowid: Number(info.lastInsertRowid), rowsAffected: Number(info.changes) };
    },
  };
}

function tursoDriver() {
  const url = TURSO_URL.replace(/^libsql:\/\//, 'https://').replace(/\/+$/, '');
  const endpoint = `${url}/v2/pipeline`;

  const toArg = (v) => {
    if (v === null || v === undefined) return { type: 'null', value: null };
    if (typeof v === 'number') {
      return Number.isInteger(v) ? { type: 'integer', value: String(v) } : { type: 'float', value: v };
    }
    if (typeof v === 'boolean') return { type: 'integer', value: v ? '1' : '0' };
    return { type: 'text', value: String(v) };
  };
  const fromCell = (c) => {
    if (!c || c.type === 'null') return null;
    if (c.type === 'integer') return Number(c.value);
    if (c.type === 'float') return typeof c.value === 'number' ? c.value : Number(c.value);
    return c.value;
  };

  return {
    name: 'turso',
    async exec(sql, params = []) {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TURSO_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requests: [
            { type: 'execute', stmt: { sql, args: params.map(toArg) } },
            { type: 'close' },
          ],
        }),
      });
      if (!res.ok) throw new Error(`Turso HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const data = await res.json();
      const first = data.results && data.results[0];
      if (!first || first.type !== 'ok') {
        const msg = (first && first.error && first.error.message) || 'Unknown Turso error';
        throw new Error(`Turso: ${msg}`);
      }
      const r = first.response.result;
      const cols = (r.cols || []).map((c) => c.name);
      const rows = (r.rows || []).map((cells) => {
        const obj = {};
        cells.forEach((cell, i) => { obj[cols[i]] = fromCell(cell); });
        return obj;
      });
      return {
        rows,
        lastInsertRowid: r.last_insert_rowid != null ? Number(r.last_insert_rowid) : 0,
        rowsAffected: r.affected_row_count || 0,
      };
    },
  };
}

const driver = TURSO_URL && TURSO_TOKEN ? tursoDriver() : localDriver();

/* ---------------- public query helpers ---------------- */
const all = async (sql, params) => (await driver.exec(sql, params)).rows;
const get = async (sql, params) => (await driver.exec(sql, params)).rows[0];
const run = (sql, params) => driver.exec(sql, params);

/* ---------------- schema ---------------- */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE)`,
  `CREATE TABLE IF NOT EXISTS goals (
    user_id INTEGER PRIMARY KEY,
    calories INTEGER NOT NULL DEFAULT 2400,
    protein INTEGER NOT NULL DEFAULT 180,
    carbs INTEGER NOT NULL DEFAULT 250,
    fat INTEGER NOT NULL DEFAULT 70,
    workouts_per_week INTEGER NOT NULL DEFAULT 4,
    meals_per_day INTEGER NOT NULL DEFAULT 3)`,
  `CREATE TABLE IF NOT EXISTS meals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    time TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL DEFAULT 'meal',
    name TEXT NOT NULL DEFAULT '',
    calories INTEGER NOT NULL DEFAULT 0,
    protein REAL NOT NULL DEFAULT 0,
    carbs REAL NOT NULL DEFAULT 0,
    fat REAL NOT NULL DEFAULT 0,
    notes TEXT NOT NULL DEFAULT '',
    photo TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE INDEX IF NOT EXISTS idx_meals_user_date ON meals(user_id, date)`,
  `CREATE TABLE IF NOT EXISTS workouts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT 'Workout',
    notes TEXT NOT NULL DEFAULT '',
    duration_min INTEGER NOT NULL DEFAULT 0,
    photo TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE INDEX IF NOT EXISTS idx_workouts_user_date ON workouts(user_id, date)`,
  `CREATE TABLE IF NOT EXISTS exercises (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workout_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS sets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    exercise_id INTEGER NOT NULL,
    reps INTEGER NOT NULL DEFAULT 0,
    weight REAL NOT NULL DEFAULT 0,
    position INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS weights (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    kg REAL NOT NULL,
    UNIQUE(user_id, date))`,
  `CREATE TABLE IF NOT EXISTS rest_days (
    user_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    PRIMARY KEY (user_id, date))`,
  `CREATE TABLE IF NOT EXISTS nudges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_user INTEGER NOT NULL,
    to_user INTEGER NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    message TEXT NOT NULL DEFAULT '',
    date TEXT NOT NULL,
    seen INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS photos (
    name TEXT PRIMARY KEY,
    mime TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS push_subs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL)`,
  // One row per ingredient in a meal. A meal's macro columns stay the source of
  // truth for every existing query/chart — they're just recomputed as the sum of
  // these rows when items are present. Meals logged before this feature simply
  // have no rows here and behave exactly as before.
  `CREATE TABLE IF NOT EXISTS meal_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    meal_id INTEGER NOT NULL,
    food_id INTEGER,
    name TEXT NOT NULL DEFAULT '',
    grams REAL NOT NULL DEFAULT 0,
    entered_qty REAL,
    entered_unit TEXT NOT NULL DEFAULT 'g',
    state TEXT NOT NULL DEFAULT 'na',
    calories REAL NOT NULL DEFAULT 0,
    protein REAL NOT NULL DEFAULT 0,
    carbs REAL NOT NULL DEFAULT 0,
    fat REAL NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'db',
    sort INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS idx_meal_items_meal ON meal_items(meal_id)`,
  // Generated weekly recaps, keyed by user + week-start (Monday, app timezone).
  `CREATE TABLE IF NOT EXISTS recaps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    week_start TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT '',
    pushed INTEGER NOT NULL DEFAULT 0,
    seen INTEGER NOT NULL DEFAULT 0,
    UNIQUE(user_id, week_start))`,
  `CREATE TABLE IF NOT EXISTS foods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    kcal REAL NOT NULL,
    protein REAL NOT NULL,
    carbs REAL NOT NULL,
    fat REAL NOT NULL,
    portion_name TEXT,
    portion_grams REAL)`,
  `CREATE TABLE IF NOT EXISTS user_foods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    kcal REAL NOT NULL,
    protein REAL NOT NULL,
    carbs REAL NOT NULL,
    fat REAL NOT NULL,
    portion_name TEXT,
    portion_grams REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS exercise_lib (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    muscle TEXT NOT NULL,
    equipment TEXT NOT NULL DEFAULT '')`,
  `CREATE TABLE IF NOT EXISTS routines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS routine_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    routine_id INTEGER NOT NULL,
    exercise TEXT NOT NULL,
    sets INTEGER NOT NULL DEFAULT 3,
    position INTEGER NOT NULL DEFAULT 0)`,
];

// Additive column migrations for older databases (ignore "duplicate column" errors)
const MIGRATIONS = [
  `ALTER TABLE meals ADD COLUMN food_id INTEGER`,
  `ALTER TABLE meals ADD COLUMN grams REAL`,
  `ALTER TABLE sets ADD COLUMN set_type TEXT NOT NULL DEFAULT 'normal'`,
  // --- multi-ingredient meals + cooked/raw awareness (2026-08-18) ---
  `ALTER TABLE foods ADD COLUMN state TEXT NOT NULL DEFAULT 'na'`,
  `ALTER TABLE foods ADD COLUMN yield_factor REAL`,
];

/* ---- cooked/raw yield factors ----
   yield_factor = cooked grams produced per 1 g of raw food.
   Meat loses water when cooked (<1); grains and legumes absorb it (>1).
   We only tag foods whose stored state we actually know from the name, so we
   never silently apply a conversion to a food we're guessing about. */
const YIELD_RULES = [
  [/\bbacon\b/i, 0.35],
  [/\bsausage\b/i, 0.75],
  [/\bspinach\b/i, 0.30],
  [/\bmushroom/i, 0.70],
  [/\brice noodles?\b|\bpasta\b|\bnoodle/i, 2.2],
  [/\brice\b/i, 2.6],
  [/\boat(s|meal)\b/i, 3.0],
  [/\bquinoa\b/i, 2.9],
  [/\bbeans?\b|\blentils?\b|\bchickpeas?\b|\bmonggo\b/i, 2.4],
  [/\bshrimp\b|\bcrab\b|\bfish\b|\bsalmon\b|\btilapia\b|\btuna\b/i, 0.85],
  [/\bchicken\b|\bbeef\b|\bpork\b|\bturkey\b|\bsteak\b|\bmeat\b/i, 0.72],
  [/\begg\b|\begg white\b/i, 0.90],
  [/\bcabbage\b|\bcauliflower\b|\bcorn\b|\bgreen beans\b|\bokra\b|\bsquash\b|\bkalabasa\b/i, 0.88],
];

// Green beans / beans ordering matters: "Green beans (sitaw)" is a vegetable, not a legume.
const VEG_OVERRIDE = /\bgreen beans\b/i;

function stateFromName(name) {
  if (/\bcooked\b/i.test(name)) return 'cooked';
  if (/\braw\b|\buncooked\b|\bdry\b/i.test(name)) return 'raw';
  return 'na';
}

function yieldFromName(name) {
  if (VEG_OVERRIDE.test(name)) return 0.88;
  for (const [re, f] of YIELD_RULES) if (re.test(name)) return f;
  return null;
}

// Idempotent: tags every food whose name declares its state. Guarded by a config
// key so we don't rewrite hundreds of rows on every boot (Turso round trips cost).
async function backfillFoodStates() {
  const done = await get(`SELECT value FROM config WHERE key = 'foods_state_v1'`);
  if (done) return;
  const foods = await all('SELECT id, name FROM foods');
  let tagged = 0;
  for (const f of foods) {
    const st = stateFromName(f.name);
    if (st === 'na') continue;
    const yf = yieldFromName(f.name);
    if (!yf) continue;
    await run('UPDATE foods SET state = ?, yield_factor = ? WHERE id = ?', [st, yf, f.id]);
    tagged++;
  }
  await run(`INSERT OR REPLACE INTO config (key, value) VALUES ('foods_state_v1', ?)`, [String(tagged)]);
  console.log(`Tagged ${tagged} foods with cooked/raw state`);
}

// Bulk-insert helper: multi-row VALUES in chunks (keeps Turso round trips low)
async function bulkInsert(table, cols, rows, chunk = 40) {
  for (let i = 0; i < rows.length; i += chunk) {
    const slice = rows.slice(i, i + chunk);
    const tuple = `(${cols.map(() => '?').join(',')})`;
    const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES ${slice.map(() => tuple).join(',')}`;
    await run(sql, slice.flat());
  }
}

async function seedLibraries() {
  const foodCount = (await get('SELECT COUNT(*) AS n FROM foods')).n;
  if (foodCount === 0) {
    const foods = require('./seed-foods');
    await bulkInsert('foods', ['name', 'kcal', 'protein', 'carbs', 'fat', 'portion_name', 'portion_grams'],
      foods.map((f) => [f[0], f[1], f[2], f[3], f[4], f[5] || null, f[6] || null]));
    console.log(`Seeded ${foods.length} foods`);
  }
  const exCount = (await get('SELECT COUNT(*) AS n FROM exercise_lib')).n;
  if (exCount === 0) {
    const exercises = require('./seed-exercises');
    await bulkInsert('exercise_lib', ['name', 'muscle', 'equipment'], exercises);
    console.log(`Seeded ${exercises.length} exercises`);
  }
}

async function init() {
  for (const sql of SCHEMA) await run(sql);
  for (const sql of MIGRATIONS) {
    try { await run(sql); } catch (err) { /* column already exists — fine */ }
  }
  await run(`INSERT OR IGNORE INTO users (id, name) VALUES (1, 'Logan')`);
  await run(`INSERT OR IGNORE INTO users (id, name) VALUES (2, 'Reiner')`);
  await run(`INSERT OR IGNORE INTO goals (user_id) VALUES (1)`);
  await run(`INSERT OR IGNORE INTO goals (user_id) VALUES (2)`);
  await seedLibraries();
  await backfillFoodStates();
  console.log(`Storage ready (driver: ${driver.name})`);
}

module.exports = { all, get, run, init, driverName: driver.name };
