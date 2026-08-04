// seed-demo.js — optional: fills 3 weeks of realistic demo data via the API.
// Usage: start the server, then `node seed-demo.js`. Delete data/accountable.db to reset.
'use strict';
const BASE = process.env.BASE || 'http://localhost:3000';

const pad = (n) => String(n).padStart(2, '0');
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
function addDays(s, n) { const d = new Date(s + 'T12:00:00'); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
const post = (p, body) => fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => { if (!r.ok) throw new Error(p); return r.json(); });
const rnd = (a, b) => Math.round(a + Math.random() * (b - a));

const MEALS = {
  breakfast: [['Oats, banana + whey', 520, 42, 62, 11], ['Eggs, toast + avocado', 480, 28, 34, 24], ['Greek yogurt bowl', 390, 35, 40, 9]],
  lunch: [['Chicken rice bowl', 680, 52, 70, 16], ['Beef burrito', 750, 45, 68, 28], ['Salmon + potatoes', 620, 44, 48, 24]],
  dinner: [['Steak, rice + veg', 720, 55, 55, 26], ['Pasta with chicken', 690, 48, 78, 17], ['Pork adobo + rice', 700, 46, 62, 25]],
  snack: [['Protein shake', 180, 30, 8, 3], ['Apple + peanut butter', 260, 7, 28, 14], ['Rice cakes + whey', 230, 26, 24, 3]],
};
const WORKOUTS = [
  ['Push day', [['Bench Press', [[80, 8], [80, 8], [82.5, 6]]], ['Overhead Press', [[45, 8], [45, 8], [47.5, 6]]], ['Tricep Pushdown', [[30, 12], [30, 12], [32.5, 10]]], ['Lateral Raise', [[10, 15], [10, 15], [10, 12]]]]],
  ['Pull day', [['Deadlift', [[140, 5], [140, 5], [150, 3]]], ['Pull-Up', [[0, 10], [0, 8], [0, 8]]], ['Barbell Row', [[70, 10], [70, 10], [72.5, 8]]], ['Bicep Curl', [[15, 12], [15, 12], [17.5, 10]]]]],
  ['Leg day', [['Squat', [[100, 8], [105, 6], [110, 5]]], ['Romanian Deadlift', [[80, 10], [80, 10], [85, 8]]], ['Leg Press', [[180, 12], [180, 12], [200, 10]]], ['Calf Raise', [[60, 15], [60, 15], [60, 15]]]]],
  ['Upper body', [['Incline Dumbbell Press', [[30, 10], [30, 10], [32.5, 8]]], ['Lat Pulldown', [[60, 12], [62.5, 10], [65, 8]]], ['Seated Cable Row', [[55, 12], [57.5, 10], [60, 10]]], ['Face Pull', [[25, 15], [25, 15], [25, 15]]]]],
];

async function seed() {
  const T = today();
  for (const userId of [1, 2]) {
    let weight = userId === 1 ? 86.5 : 79.2;
    let woIdx = userId; // offset so their splits differ
    for (let back = 20; back >= 0; back--) {
      const date = addDays(T, -back);
      const isToday = back === 0;
      const skipDay = !isToday && Math.random() < (userId === 1 ? 0.08 : 0.16); // Reiner slips more
      if (skipDay) continue;

      // meals
      const types = isToday ? (userId === 1 ? ['breakfast', 'lunch'] : ['breakfast']) : ['breakfast', 'lunch', 'dinner', ...(Math.random() < 0.5 ? ['snack'] : [])];
      const times = { breakfast: `0${rnd(7, 8)}:${pad(rnd(10, 50))}`, lunch: `12:${pad(rnd(10, 50))}`, dinner: `19:${pad(rnd(0, 45))}`, snack: `16:${pad(rnd(0, 45))}` };
      for (const t of types) {
        const [name, c, p, cb, f] = MEALS[t][rnd(0, MEALS[t].length - 1)];
        await post('/api/meals', { userId, date, time: times[t], type: t, name, calories: c + rnd(-40, 40), protein: p + rnd(-4, 4), carbs: cb + rnd(-6, 6), fat: f + rnd(-3, 3) });
      }

      // workout (~5 of 7 days for Logan, ~4 for Reiner) — none yet today
      if (!isToday) {
        if (Math.random() < (userId === 1 ? 0.7 : 0.55)) {
          const [title, exs] = WORKOUTS[woIdx++ % WORKOUTS.length];
          await post('/api/workouts', {
            userId, date, title, durationMin: rnd(48, 75),
            exercises: exs.map(([name, sets]) => ({ name, sets: sets.map(([w, r]) => ({ weight: w, reps: r + rnd(-1, 1) })) })),
          });
        } else if (Math.random() < 0.75) {
          await post('/api/rest-day', { userId, date });
        }
      }

      // weight most mornings, slowly trending down
      if (Math.random() < 0.8) {
        weight += (Math.random() - 0.62) * 0.35;
        await post('/api/weights', { userId, date, kg: Math.round(weight * 10) / 10 });
      }
    }
  }
  // a pending nudge from Logan to Reiner
  await post('/api/nudges', { fromUser: 1, toUser: 2, reason: 'Workout not done', message: 'Leg day. No excuses.', date: T });
  console.log('Demo data seeded.');
}

seed().catch((e) => { console.error(e); process.exit(1); });
