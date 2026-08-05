/* Accountable — frontend SPA (vanilla JS, zero dependencies) */
'use strict';

/* ---------------- helpers ---------------- */
const $ = (sel, root = document) => root.querySelector(sel);

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style') el.style.cssText = v;
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(c));
  }
  return el;
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    let msg = 'Request failed';
    try { msg = (await res.json()).error || msg; } catch {}
    throw new Error(msg);
  }
  return res.json();
}

const pad = (n) => String(n).padStart(2, '0');
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const nowTime = () => {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function fmtDate(dateStr, opts = { weekday: 'long', month: 'short', day: 'numeric' }) {
  return new Date(dateStr + 'T12:00:00').toLocaleDateString(undefined, opts);
}
const round1 = (n) => Math.round(n * 10) / 10;

/* ---------------- state ---------------- */
const USERS = { 1: 'Logan', 2: 'Reiner' };
const state = {
  me: Number(localStorage.getItem('acc.me') || 1),
  tab: localStorage.getItem('acc.tab') || 'today',
  date: todayStr(),
  progressUser: null, // defaults to me
  progressRange: 30,
  progressEx: null, // selected exercise on the strength chart
  ai: false, // set from /api/health — server has a Gemini key configured
};
const partnerOf = (id) => (Number(id) === 1 ? 2 : 1);

/* ---------------- toast & sheet ---------------- */
function toast(msg) {
  const root = $('#toastRoot');
  root.innerHTML = '';
  const t = h('div', { class: 'toast' }, msg);
  root.append(t);
  setTimeout(() => t.remove(), 2200);
}

function openSheet(build, opts = {}) {
  const overlay = h('div', { class: 'sheet-overlay', onClick: (e) => { if (e.target === overlay) { if (opts.guard && !opts.guard()) return; close(); } } });
  const sheet = h('div', { class: 'sheet' }, h('div', { class: 'sheet-grab' }));
  overlay.append(sheet);
  $('#sheetRoot').append(overlay);
  const closers = [];
  const close = () => { closers.forEach((f) => f()); overlay.remove(); };
  close.onClose = (f) => closers.push(f);
  build(sheet, close);
  return close;
}

/* ---------------- push notifications ---------------- */
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

function urlB64ToUint8(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

async function enablePush() {
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { toast('Notifications not allowed'); render(); return; }
    const reg = await navigator.serviceWorker.ready;
    const { key } = await api('/api/push/pubkey');
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(key) });
    await api('/api/push/subscribe', { method: 'POST', body: { userId: state.me, subscription: sub.toJSON() } });
    toast(`This device will get ${USERS[state.me]}'s nudges`);
    render();
  } catch (err) {
    toast('Could not enable notifications');
  }
}

/* ---------------- photo picker ---------------- */
function photoField(existingUrl) {
  // Returns { el, getData: () => dataUrl|null, removed: () => bool }
  let dataUrl = null;
  let removed = false;
  const input = h('input', { type: 'file', accept: 'image/*' });
  const preview = h('div', { style: 'display:flex;align-items:center;gap:10px;flex:1' });
  const label = h('span', {}, existingUrl ? 'Photo attached — tap to replace' : 'Add photo');

  function setPreview(src) {
    preview.innerHTML = '';
    if (src) preview.append(h('img', { src }), label);
    else preview.append(camIcon(), label);
  }
  setPreview(existingUrl ? `/uploads/${existingUrl}` : null);

  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;
    dataUrl = await downscale(file);
    removed = false;
    label.textContent = 'Photo ready — tap to replace';
    setPreview(dataUrl);
  });

  const removeBtn = existingUrl
    ? h('button', { class: 'btn small ghost', type: 'button', onClick: (e) => { e.stopPropagation(); removed = true; dataUrl = null; label.textContent = 'Add photo'; setPreview(null); } }, 'Remove')
    : null;

  const el = h('label', { class: 'photo-drop' }, input, preview, removeBtn);
  return { el, getData: () => dataUrl, removed: () => removed };
}

function downscale(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const max = 1280;
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = reject;
    img.src = url;
  });
}

/* ---------------- icons (inline SVG, stroke = currentColor) ---------------- */
const icon = (paths, vb = '0 0 24 24') =>
  `<svg viewBox="${vb}" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
const ICONS = {
  today: icon('<rect x="3" y="4" width="18" height="17" rx="3"/><path d="M3 9h18M8 2v4M16 2v4"/><path d="M8.5 14.5l2.5 2.5 4.5-4.5"/>'),
  food: icon('<path d="M7 2v9M4.5 2v5.5a2.5 2.5 0 0 0 5 0V2"/><path d="M7 11v11"/><path d="M17 2c-2 2.5-2.6 5.4-2.6 8.2 0 1.5 1.2 2.3 2.6 2.3V22"/><path d="M17 2c1.6 2 2.6 4.8 2.6 8.2"/>'),
  train: icon('<path d="M6.5 6.5v11M17.5 6.5v11M3.5 9v6M20.5 9v6M6.5 12h11"/>'),
  progress: icon('<path d="M3 21h18"/><path d="M5 21V14M10 21V9M15 21v-8M20 21V5"/>'),
};
function camIcon() {
  const s = h('span', { style: 'width:24px;height:24px;color:inherit', html: icon('<path d="M4 8h3l2-3h6l2 3h3v12H4z"/><circle cx="12" cy="13.5" r="3.4"/>') });
  return s;
}

/* ---------------- shell ---------------- */
function renderShell() {
  const sw = $('#userSwitch');
  sw.innerHTML = '';
  [1, 2].forEach((id) => {
    sw.append(h('button', {
      class: state.me === id ? 'active' : '',
      role: 'tab', 'aria-selected': state.me === id,
      onClick: () => { state.me = id; localStorage.setItem('acc.me', id); state.progressUser = null; render(); },
    }, USERS[id]));
  });

  const tb = $('#tabbar');
  tb.innerHTML = '';
  const tabs = [['today', 'Today'], ['food', 'Food'], ['train', 'Train'], ['progress', 'Progress']];
  tabs.forEach(([key, label]) => {
    const b = h('button', {
      class: state.tab === key ? 'active' : '',
      onClick: () => { state.tab = key; localStorage.setItem('acc.tab', key); state.date = todayStr(); render(); },
    });
    b.innerHTML = ICONS[key];
    b.append(h('span', {}, label));
    tb.append(b);
  });
}

/* ---------------- shared UI pieces ---------------- */
function dateNav(onChange) {
  const isToday = state.date === todayStr();
  return h('div', { class: 'datenav' },
    h('button', { 'aria-label': 'Previous day', onClick: () => { state.date = addDays(state.date, -1); onChange(); }, html: '&#8249;' }),
    h('div', { class: 'dn-center' },
      h('div', { class: 'dn-title' }, isToday ? 'Today' : fmtDate(state.date, { weekday: 'long' })),
      h('div', { class: 'dn-sub' }, fmtDate(state.date, { month: 'long', day: 'numeric', year: 'numeric' })),
    ),
    h('button', { 'aria-label': 'Next day', disabled: isToday, onClick: () => { state.date = addDays(state.date, 1); onChange(); }, html: '&#8250;' }),
  );
}

function meter(value, goal, over = value > goal) {
  const pct = goal > 0 ? Math.min(100, (value / goal) * 100) : 0;
  return h('div', { class: 'meter' + (over ? ' over' : '') }, h('i', { style: `width:${pct}%` }));
}

/* ---------------- TODAY ---------------- */
async function renderToday(main) {
  const data = await api(`/api/summary?date=${state.date}`);
  const meU = data.users.find((u) => u.userId === state.me);
  const partnerU = data.users.find((u) => u.userId !== state.me);

  main.innerHTML = '';
  main.append(dateNav(render));

  // Incoming nudges for me
  for (const n of meU.unseenNudges) {
    main.append(h('div', { class: 'nudge-banner' },
      h('div', { class: 'nb-body' },
        h('b', {}, `${n.from_name} nudged you: `),
        `${n.reason}${n.message ? ` — “${n.message}”` : ''}`,
        h('div', { class: 'sub' }, fmtDate(n.date, { month: 'short', day: 'numeric' })),
      ),
      h('button', { class: 'btn small', onClick: async () => { await api(`/api/nudges/${n.id}/seen`, { method: 'POST' }); render(); } }, 'Got it'),
    ));
  }

  // Offer push notifications (shows inside the installed app when not yet enabled)
  if (pushSupported() && Notification.permission === 'default' && !localStorage.getItem('acc.pushDismissed')) {
    main.append(h('div', { class: 'nudge-banner' },
      h('div', { class: 'nb-body' },
        h('b', {}, 'Get pinged on this phone '),
        `when ${partnerU.name} nudges you.`,
      ),
      h('button', { class: 'btn small primary', onClick: enablePush }, 'Turn on'),
      h('button', { class: 'btn small ghost', onClick: () => { localStorage.setItem('acc.pushDismissed', '1'); render(); } }, 'Later'),
    ));
  }

  const grid = h('div', { class: 'grid2' });
  grid.append(personCard(meU, true), personCard(partnerU, false));
  main.append(grid);

  // Photo strip for the day (both users)
  const photos = [];
  for (const u of data.users) {
    u.meals.filter((m) => m.photo).forEach((m) => photos.push({ src: m.photo, cap: `${u.name} · ${m.type}` }));
    u.workouts.filter((w) => w.photo).forEach((w) => photos.push({ src: w.photo, cap: `${u.name} · workout` }));
  }
  if (photos.length) {
    const card = h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Photos'), h('span', { class: 'sub' }, `${photos.length} today`)),
      h('div', { class: 'photo-strip' }, photos.map((p) =>
        h('div', {}, h('img', { src: `/uploads/${p.src}`, loading: 'lazy', alt: p.cap }), h('div', { class: 'ps-cap' }, p.cap)),
      )),
    );
    main.append(card);
  }
}

function personCard(u, isMe) {
  const g = u.goals;
  const remaining = g.calories - u.totals.calories;
  const over = remaining < 0;

  const chips = h('div', { class: 'status-row' },
    chip(u.trained ? 'Workout done' : u.rest ? 'Rest day' : 'No workout', u.trained || u.rest),
    chip(`Meals ${u.meals.length}`, u.meals.length > 0),
    chip(u.mealPhotos + u.workoutPhotos > 0 ? 'Photos in' : 'No photos', u.mealPhotos + u.workoutPhotos > 0),
    u.weight != null ? chip(`${u.weight} kg`, true) : null,
  );

  const macros = h('div', { class: 'macros' },
    macroMeter('Protein', u.totals.protein, g.protein, 'g'),
    macroMeter('Carbs', u.totals.carbs, g.carbs, 'g'),
    macroMeter('Fat', u.totals.fat, g.fat, 'g'),
  );

  const missedBlock = u.missed.length
    ? h('div', { class: 'missed' }, u.missed.map((m) => h('div', { class: 'mi' }, m)))
    : h('div', { class: 'all-done' }, 'All caught up for the day');

  const card = h('div', { class: 'card' },
    h('div', { class: 'card-head' },
      h('h2', {}, isMe ? `${u.name} (you)` : u.name),
      h('span', { class: 'streak-chip' }, streakFlame(), `${u.streak} day${u.streak === 1 ? '' : 's'}`),
    ),
    chips,
    h('div', { class: 'cal-line' },
      h('span', { class: 'big' }, String(u.totals.calories)),
      h('span', { class: 'of' }, `/ ${g.calories} kcal`),
      h('span', { class: 'rem' + (over ? ' over' : '') }, over ? `${-remaining} over` : `${remaining} left`),
    ),
    meter(u.totals.calories, g.calories),
    macros,
    missedBlock,
  );

  if (isMe) {
    card.append(h('div', { class: 'qa-row' },
      h('button', { class: 'btn primary', onClick: () => mealSheet() }, '+ Meal'),
      h('button', { class: 'btn primary', onClick: () => workoutSheet() }, '+ Workout'),
      h('button', { class: 'btn', onClick: () => weightSheet(u.weight) }, u.weight != null ? 'Update weight' : 'Log weight'),
      h('button', { class: 'btn', onClick: async () => {
        const r = await api('/api/rest-day', { method: 'POST', body: { userId: state.me, date: state.date } });
        toast(r.rest ? 'Rest day set' : 'Rest day removed'); render();
      } }, u.rest ? 'Unset rest day' : 'Rest day'),
    ));
  } else {
    card.append(h('div', { class: 'qa-row', style: 'grid-template-columns:1fr' },
      h('button', { class: 'btn', onClick: () => nudgeSheet(u) }, `Nudge ${u.name}`),
    ));
  }
  return card;
}

const chip = (label, done) => h('span', { class: 'chip' + (done ? ' done' : '') }, h('i', { class: 'dot' }), label);
const macroMeter = (name, val, goal, unit) =>
  h('div', { class: 'macro' },
    h('div', { class: 'm-label' }, h('span', {}, name), h('b', {}, `${Math.round(val)}/${goal}${unit}`)),
    meter(val, goal),
  );
function streakFlame() {
  return h('span', { style: 'width:13px;height:13px;display:inline-block', html: icon('<path d="M12 2c1 4-4 5.5-4 10a4 4 0 0 0 8 0c0-2-1-3.5-1-3.5s2.5 1 2.5 4A5.5 5.5 0 0 1 12 21a6.5 6.5 0 0 1-6.5-6.5C5.5 8 12 7 12 2z"/>') });
}

/* ---------------- nudge sheet ---------------- */
function nudgeSheet(partner) {
  const reasons = [
    'Meal not logged', 'Workout not done', 'No photo today', 'Daily update missing', 'Goal missed', 'Just checking in',
  ];
  // Smart default: pick the first thing they actually missed
  const preselect = partner.missed.length
    ? (partner.missed[0].includes('meal') || partner.missed[0].includes('Meal') || partner.missed[0].includes('meals') ? 'Meal not logged'
      : partner.missed[0].includes('workout') ? 'Workout not done'
      : partner.missed[0].includes('photo') ? 'No photo today' : 'Daily update missing')
    : 'Just checking in';
  let reason = preselect;

  openSheet((sheet, close) => {
    const seg = h('div', { class: 'f-row' }, h('label', {}, 'Reason'));
    const list = h('div', { style: 'display:flex;flex-wrap:wrap;gap:7px' });
    reasons.forEach((r) => {
      const b = h('button', { class: 'chip' + (r === reason ? ' done' : ''), type: 'button', onClick: () => {
        reason = r;
        list.querySelectorAll('button').forEach((x) => x.classList.remove('done'));
        b.classList.add('done');
      } }, r);
      list.append(b);
    });
    seg.append(list);
    const msg = h('textarea', { rows: 2, placeholder: `Optional message to ${partner.name}…` });

    sheet.append(
      h('h3', {}, `Nudge ${partner.name}`),
      partner.missed.length
        ? h('div', { class: 'card', style: 'padding:10px 12px;margin-bottom:12px' },
            h('div', { class: 'sub', style: 'margin-bottom:4px;font-weight:700' }, `${partner.name} is missing today:`),
            partner.missed.map((m) => h('div', { class: 'mi', style: 'font-size:0.83rem;color:var(--ink-70)' }, `• ${m}`)))
        : null,
      seg,
      h('div', { class: 'f-row' }, h('label', {}, 'Message'), msg),
      h('div', { class: 'form-actions' },
        h('button', { class: 'btn ghost', onClick: close }, 'Cancel'),
        h('button', { class: 'btn primary', onClick: async () => {
          await api('/api/nudges', { method: 'POST', body: { fromUser: state.me, toUser: partner.userId, reason, message: msg.value.trim(), date: state.date } });
          close(); toast(`Nudge sent to ${partner.name}`);
        } }, 'Send nudge'),
      ),
    );
  });
}

/* ---------------- weight sheet ---------------- */
function weightSheet(current) {
  openSheet((sheet, close) => {
    const input = h('input', { type: 'number', step: '0.1', min: '20', max: '300', inputmode: 'decimal', value: current ?? '', placeholder: 'e.g. 82.4' });
    sheet.append(
      h('h3', {}, `Body weight — ${fmtDate(state.date, { month: 'short', day: 'numeric' })}`),
      h('div', { class: 'f-row' }, h('label', {}, 'Weight (kg)'), input),
      h('div', { class: 'form-actions' },
        h('button', { class: 'btn ghost', onClick: close }, 'Cancel'),
        h('button', { class: 'btn primary', onClick: async () => {
          const kg = Number(input.value);
          if (!kg) return toast('Enter a weight');
          await api('/api/weights', { method: 'POST', body: { userId: state.me, date: state.date, kg } });
          close(); toast('Weight logged'); render();
        } }, 'Save'),
      ),
    );
    setTimeout(() => input.focus(), 50);
  });
}

/* ---------------- meal sheet (search-first, MyFitnessPal-style) ---------------- */
function mealSheet(existing) {
  const isEdit = !!existing;
  let type = existing?.type || suggestMealType();
  let selFood = null; // selected database food (per-100g values) → grams math applies
  let selFoodId = existing?.food_id || null;

  openSheet((sheet, close) => {
    const seg = h('div', { class: 'seg' });
    ['breakfast', 'lunch', 'dinner', 'snack'].forEach((t) => {
      const b = h('button', { class: t === type ? 'active' : '', type: 'button', onClick: () => {
        type = t;
        seg.querySelectorAll('button').forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
      } }, t[0].toUpperCase() + t.slice(1));
      seg.append(b);
    });

    const name = h('input', { type: 'text', placeholder: 'Search food, or type anything…', value: existing?.name || '', autocomplete: 'off' });
    const time = h('input', { type: 'time', value: existing?.time || nowTime() });
    const cal = numInput(existing?.calories, 'kcal');
    const pro = numInput(existing?.protein, 'g');
    const carb = numInput(existing?.carbs, 'g');
    const fat = numInput(existing?.fat, 'g');
    const notes = h('textarea', { rows: 2, placeholder: 'Notes (optional)' }, existing?.notes || '');
    const photo = photoField(existing?.photo);
    const results = h('div', { class: 'fs-results', style: 'display:none' });
    const note = h('div', { class: 'ai-note', style: 'display:none' });

    // grams row (shows when a database food is picked)
    const grams = h('input', { type: 'number', min: '1', inputmode: 'numeric', value: existing?.grams || '', onInput: () => recalc() });
    const gramsHint = h('span', { class: 'ai-note', style: 'margin-top:0' });
    const gramsRow = h('div', { class: 'grams-row', style: 'display:none' }, grams, h('span', { style: 'font-weight:700;font-size:0.85rem' }, 'g'), gramsHint);

    function setNote(text) { note.style.display = ''; note.textContent = text; }
    function recalc() {
      if (!selFood) return;
      const k = (Number(grams.value) || 0) / 100;
      cal.value = Math.round(selFood.kcal * k);
      pro.value = round1(selFood.protein * k);
      carb.value = round1(selFood.carbs * k);
      fat.value = round1(selFood.fat * k);
      setNote('Auto-calculated — tap any number to adjust it.');
    }
    function pickDb(f) {
      selFood = f; selFoodId = f.id;
      name.value = f.name;
      results.style.display = 'none';
      gramsRow.style.display = '';
      if (!Number(grams.value)) grams.value = f.portion_grams || 100;
      gramsHint.textContent = f.portion_name && f.portion_grams ? `${f.portion_name} ≈ ${f.portion_grams} g` : 'per 100 g in database';
      recalc();
    }
    function fillDirect(nm, c, p, cb, f, tagText) {
      selFood = null; selFoodId = null;
      name.value = nm; cal.value = c; pro.value = round1(p); carb.value = round1(cb); fat.value = round1(f);
      results.style.display = 'none'; gramsRow.style.display = 'none';
      setNote(tagText);
    }

    const rowEl = (label, tag, fn, extra) => h('div', { class: 'fs-row', onClick: fn }, h('span', {}, label), h('span', { class: 'fs-tag' }, tag), extra);
    const headEl = (t) => h('div', { class: 'fs-row', style: 'cursor:default;font-size:0.68rem;font-weight:800;text-transform:uppercase;letter-spacing:0.05em;color:var(--ink-55);padding:7px 12px' }, t);

    let searchTimer = null;
    async function doSearch() {
      const q = name.value.trim();
      let data;
      try { data = await api(`/api/foods?user=${state.me}&q=${encodeURIComponent(q)}`); } catch { return; }
      if (name.value.trim() !== q) return; // stale response
      results.innerHTML = '';
      let any = false;
      if (!q) {
        if (data.myFoods?.length) {
          results.append(headEl('My foods'));
          data.myFoods.forEach((f) => {
            results.append(rowEl(f.name, `${f.kcal} kcal`, () => fillDirect(f.name, f.kcal, f.protein, f.carbs, f.fat, 'From My Foods — edit anything.'),
              h('button', { class: 'x', type: 'button', 'aria-label': 'Remove from My Foods', html: '&#10005;', style: 'color:var(--ink-35);padding:0 2px', onClick: async (e) => {
                e.stopPropagation();
                await api(`/api/user-foods/${f.id}`, { method: 'DELETE' }); doSearch();
              } })));
            any = true;
          });
        }
        if (data.recents?.length) {
          results.append(headEl('Recent'));
          data.recents.forEach((r) => {
            results.append(rowEl(r.name, `${r.calories} kcal`, () => fillDirect(r.name, r.calories, r.protein, r.carbs, r.fat, 'Copied from your last log — edit anything.')));
            any = true;
          });
        }
      } else {
        (data.mine || []).forEach((f) => {
          results.append(rowEl(f.name, `My food · ${f.kcal} kcal`, () => fillDirect(f.name, f.kcal, f.protein, f.carbs, f.fat, 'From My Foods — edit anything.')));
          any = true;
        });
        (data.foods || []).forEach((f) => {
          results.append(rowEl(f.name, `${f.kcal} kcal / 100 g`, () => pickDb(f)));
          any = true;
        });
      }
      results.style.display = any ? '' : 'none';
    }
    name.addEventListener('input', () => {
      selFood = null; selFoodId = null; gramsRow.style.display = 'none';
      clearTimeout(searchTimer); searchTimer = setTimeout(doSearch, 220);
    });
    name.addEventListener('focus', doSearch);
    sheet.addEventListener('pointerdown', (e) => {
      if (!results.contains(e.target) && e.target !== name) results.style.display = 'none';
    });

    // AI estimate (only shown when the server has a key configured)
    let aiBtn = null;
    if (state.ai) {
      aiBtn = h('button', { class: 'btn btn-wide', type: 'button', style: 'margin-top:8px', onClick: async () => {
        const text = name.value.trim();
        const pd = photo.getData() || null;
        if (!text && !pd) return toast('Type what you ate or add a photo first');
        aiBtn.disabled = true; aiBtn.textContent = 'Estimating…';
        try {
          const r = await api('/api/ai/estimate', { method: 'POST', body: { text, photoData: pd } });
          selFood = null; selFoodId = null; gramsRow.style.display = 'none'; results.style.display = 'none';
          if (!text && r.name) name.value = r.name;
          cal.value = r.calories; pro.value = r.protein; carb.value = r.carbs; fat.value = r.fat;
          setNote(`~AI estimate (${r.confidence} confidence). Estimates vary — tweak any number if it looks off.`);
        } catch (err) { toast(err.message); }
        aiBtn.disabled = false; aiBtn.textContent = '✨ Estimate with AI';
      } }, '✨ Estimate with AI');
    }

    const saveMine = h('input', { type: 'checkbox', style: 'width:auto;accent-color:var(--accent)' });
    const saveMineRow = h('label', { style: 'display:flex;gap:8px;align-items:center;cursor:pointer;font-size:0.8rem;color:var(--ink-70);margin-top:10px' },
      saveMine, 'Save to My Foods so it’s one tap next time');

    sheet.append(
      h('h3', {}, isEdit ? 'Edit meal' : 'Log meal',
        isEdit ? h('button', { class: 'btn small danger', onClick: async () => {
          if (!confirm('Delete this meal?')) return;
          await api(`/api/meals/${existing.id}`, { method: 'DELETE' });
          close(); toast('Meal deleted'); render();
        } }, 'Delete') : null),
      h('div', { class: 'f-row' }, h('label', {}, 'Meal type'), seg),
      h('div', { class: 'f-row' }, h('label', {}, 'What did you eat?'), name, results, gramsRow, aiBtn),
      h('div', { class: 'f-row' }, h('label', {}, 'Calories & macros'),
        h('div', { class: 'f-grid-4' },
          labeled(cal, 'kcal'), labeled(pro, 'Protein'), labeled(carb, 'Carbs'), labeled(fat, 'Fat'),
        ), note, saveMineRow),
      h('div', { class: 'f-row f-grid' },
        h('div', {}, h('label', {}, 'Time'), time),
        h('div', {}, h('label', {}, 'Photo'), photo.el),
      ),
      h('div', { class: 'f-row' }, h('label', {}, 'Notes'), notes),
      h('div', { class: 'form-actions' },
        h('button', { class: 'btn ghost', onClick: close }, 'Cancel'),
        h('button', { class: 'btn primary', onClick: async () => {
          const body = {
            userId: state.me, date: existing?.date || state.date, time: time.value, type,
            name: name.value.trim(), calories: Number(cal.value) || 0, protein: Number(pro.value) || 0,
            carbs: Number(carb.value) || 0, fat: Number(fat.value) || 0, notes: notes.value.trim(),
            foodId: selFoodId, grams: selFood ? Number(grams.value) || null : (Number(grams.value) || null),
          };
          if (photo.getData()) body.photoData = photo.getData();
          if (photo.removed()) body.removePhoto = true;
          if (saveMine.checked && body.name && body.calories) {
            try {
              await api('/api/user-foods', { method: 'POST', body: {
                userId: state.me, name: body.name, kcal: body.calories, protein: body.protein,
                carbs: body.carbs, fat: body.fat, portionGrams: body.grams,
              } });
            } catch {}
          }
          if (isEdit) await api(`/api/meals/${existing.id}`, { method: 'PUT', body });
          else await api('/api/meals', { method: 'POST', body });
          close(); toast(isEdit ? 'Meal updated' : 'Meal logged'); render();
        } }, isEdit ? 'Save changes' : 'Log meal'),
      ),
    );
  });
}
const numInput = (val, ph) => h('input', { type: 'number', min: '0', inputmode: 'numeric', placeholder: ph, value: val ?? '' });
const labeled = (input, lab) => h('div', {}, h('div', { style: 'font-size:0.66rem;font-weight:700;color:var(--ink-55);margin-bottom:3px;text-align:center' }, lab), input);
function suggestMealType() {
  const hr = new Date().getHours();
  if (hr < 10.5) return 'breakfast';
  if (hr < 15) return 'lunch';
  if (hr < 20.5) return 'dinner';
  return 'snack';
}

/* ---------------- FOOD ---------------- */
async function renderFood(main) {
  const meals = await api(`/api/meals?user=${state.me}&date=${state.date}`);
  const goals = await api(`/api/goals?user=${state.me}`);
  const totals = meals.reduce((t, m) => ({ calories: t.calories + m.calories, protein: t.protein + m.protein, carbs: t.carbs + m.carbs, fat: t.fat + m.fat }), { calories: 0, protein: 0, carbs: 0, fat: 0 });

  main.innerHTML = '';
  main.append(dateNav(render));

  main.append(h('button', { class: 'btn primary btn-wide', style: 'margin-bottom:16px;padding:14px', onClick: () => mealSheet() }, `+ Log meal · ${USERS[state.me]}`));

  const summary = h('div', { class: 'card' },
    h('div', { class: 'cal-line' },
      h('span', { class: 'big' }, String(totals.calories)),
      h('span', { class: 'of' }, `/ ${goals.calories} kcal`),
      h('span', { class: 'rem' + (totals.calories > goals.calories ? ' over' : '') },
        totals.calories > goals.calories ? `${totals.calories - goals.calories} over` : `${goals.calories - totals.calories} left`),
    ),
    meter(totals.calories, goals.calories),
    h('div', { class: 'macros' },
      macroMeter('Protein', totals.protein, goals.protein, 'g'),
      macroMeter('Carbs', totals.carbs, goals.carbs, 'g'),
      macroMeter('Fat', totals.fat, goals.fat, 'g'),
    ),
  );
  main.append(summary);

  const list = h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Meals'), h('span', { class: 'sub' }, `${meals.length} logged`)));
  if (!meals.length) {
    list.append(h('div', { class: 'empty' }, h('b', {}, 'Nothing logged'), 'Tap “Log meal” — it takes 20 seconds.'));
  }
  meals.forEach((m) => {
    list.append(h('div', { class: 'entry', onClick: () => mealSheet(m) },
      m.photo
        ? h('img', { class: 'thumb', src: `/uploads/${m.photo}`, loading: 'lazy', alt: '' })
        : h('div', { class: 'thumb ph' }, camIcon()),
      h('div', { class: 'e-body' },
        h('div', { class: 'e-title' }, h('span', { class: 'tag' }, m.type), m.name || 'Meal'),
        h('div', { class: 'e-sub' }, `P ${round1(m.protein)} · C ${round1(m.carbs)} · F ${round1(m.fat)}${m.notes ? ` — ${m.notes}` : ''}`),
      ),
      h('div', { class: 'e-right' },
        h('div', { class: 'e-cal' }, `${m.calories}`),
        h('div', { class: 'e-time' }, m.time || ''),
      ),
    ));
  });
  main.append(list);

  // partner's day, read-only
  const pid = partnerOf(state.me);
  const pMeals = await api(`/api/meals?user=${pid}&date=${state.date}`);
  const pCard = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, `${USERS[pid]}'s meals`), h('span', { class: 'sub' }, `${pMeals.reduce((s, m) => s + m.calories, 0)} kcal`)));
  if (!pMeals.length) pCard.append(h('div', { class: 'empty' }, `${USERS[pid]} hasn't logged anything ${state.date === todayStr() ? 'yet today' : 'this day'}.`));
  pMeals.forEach((m) => {
    pCard.append(h('div', { class: 'entry', style: 'cursor:default' },
      m.photo ? h('img', { class: 'thumb', src: `/uploads/${m.photo}`, loading: 'lazy', alt: '' }) : h('div', { class: 'thumb ph' }, camIcon()),
      h('div', { class: 'e-body' },
        h('div', { class: 'e-title' }, h('span', { class: 'tag' }, m.type), m.name || 'Meal'),
        h('div', { class: 'e-sub' }, `P ${round1(m.protein)} · C ${round1(m.carbs)} · F ${round1(m.fat)}`),
      ),
      h('div', { class: 'e-right' }, h('div', { class: 'e-cal' }, `${m.calories}`), h('div', { class: 'e-time' }, m.time || '')),
    ));
  });
  main.append(pCard);
}

/* ---------------- workout sheet (Hevy-style) ---------------- */
const MUSCLES = ['chest', 'back', 'shoulders', 'biceps', 'triceps', 'forearms', 'quads', 'hamstrings', 'glutes', 'calves', 'core', 'cardio', 'full body'];
const SET_TYPES = ['normal', 'warmup', 'failure', 'drop'];
const SET_LABEL = { warmup: 'W', failure: 'F', drop: 'D' };
const newSet = () => ({ reps: '', weight: '', type: 'normal', done: false });

function workoutSheet(existing, opts = {}) {
  const isEdit = !!existing;
  const live = !!opts.live;
  const exercises = existing
    ? existing.exercises.map((e) => ({ name: e.name, sets: e.sets.map((s) => ({ reps: s.reps, weight: s.weight, type: s.set_type || 'normal', done: true })) }))
    : opts.routine
      ? opts.routine.items.map((it) => ({ name: it.exercise, sets: Array.from({ length: it.sets || 3 }, newSet) }))
      : [{ name: '', sets: [newSet()] }];
  const ghosts = {}; // exercise name -> {lastDate, lastSets, pr} | null
  const startedAt = Date.now();
  let restEnd = 0;
  let restLen = Number(localStorage.getItem('acc.rest') || 90);
  let dirty = false;

  openSheet((sheet, close) => {
    const title = h('input', { type: 'text', placeholder: 'e.g. Push day', value: existing?.title || opts.routine?.title || '' });
    const duration = h('input', { type: 'number', min: '0', inputmode: 'numeric', placeholder: live ? 'auto' : 'min', value: existing?.duration_min || '' });
    const notes = h('textarea', { rows: 2, placeholder: 'Notes (optional)' }, existing?.notes || '');
    const photo = photoField(existing?.photo);
    const exWrap = h('div');

    /* --- live mode: elapsed clock + rest timer --- */
    const clock = h('span', { class: 'live-clock' }, '0:00');
    const restCount = h('span', { class: 'rest-count' }, '');
    const restBar = h('div', { class: 'rest-bar' },
      h('span', { style: 'font-size:0.8rem;font-weight:700' }, 'Rest'), restCount,
      h('span', { style: 'flex:1' }),
      h('button', { class: 'btn small', type: 'button', onClick: () => { if (restEnd) restEnd += 30000; } }, '+30s'),
      h('button', { class: 'btn small', type: 'button', onClick: () => stopRest() }, 'Skip'),
    );
    const startRest = () => { restEnd = Date.now() + restLen * 1000; restBar.classList.add('on'); };
    const stopRest = () => { restEnd = 0; restBar.classList.remove('on'); };
    const mmss = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${pad(s % 60)}`; };
    let liveTop = null;
    if (live) {
      const restChips = h('div', { class: 'chip-row' });
      [60, 90, 120, 180].forEach((n) => {
        const b = h('button', { class: 'chip' + (n === restLen ? ' done' : ''), type: 'button', onClick: () => {
          restLen = n; localStorage.setItem('acc.rest', n);
          restChips.querySelectorAll('button').forEach((x) => x.classList.remove('done'));
          b.classList.add('done');
        } }, `${n}s`);
        restChips.append(b);
      });
      liveTop = h('div', { class: 'live-top' },
        h('div', { class: 'live-head' },
          h('div', {}, h('div', { class: 'sub', style: 'font-size:0.72rem' }, 'Workout time'), clock),
          h('div', {}, h('div', { class: 'sub', style: 'font-size:0.72rem;margin-bottom:3px' }, 'Rest after each set'), restChips),
        ),
        restBar,
      );
      const tick = setInterval(() => {
        clock.textContent = mmss(Date.now() - startedAt);
        if (restEnd) {
          const left = restEnd - Date.now();
          if (left <= 0) {
            stopRest(); toast('Rest over — next set');
            try { navigator.vibrate && navigator.vibrate([180, 90, 180]); } catch {}
          } else restCount.textContent = mmss(left);
        }
      }, 400);
      close.onClose(() => clearInterval(tick));
    }

    /* --- ghost data ("last time" + PR) --- */
    async function loadGhost(nm) {
      nm = nm.trim();
      if (!nm || nm in ghosts) return;
      ghosts[nm] = null;
      try { ghosts[nm] = await api(`/api/exercise-last?user=${state.me}&name=${encodeURIComponent(nm)}`); } catch {}
      const g = ghosts[nm];
      if (g && g.lastSets.length) {
        // fresh exercise → mirror last time's set count as ghost rows
        for (const ex of exercises) {
          if (ex.name.trim() === nm && ex.sets.length === 1 && !ex.sets[0].reps && !ex.sets[0].weight) {
            ex.sets = g.lastSets.map(() => newSet());
          }
        }
      }
      renderExercises();
    }
    exercises.forEach((ex) => { if (ex.name.trim()) loadGhost(ex.name); });

    /* --- exercise blocks --- */
    function renderExercises() {
      exWrap.innerHTML = '';
      exercises.forEach((ex, i) => {
        const block = h('div', { class: 'ex-block' });
        const resultsEl = h('div', { class: 'ex-results', style: 'display:none' });
        const nameInput = h('input', { type: 'text', placeholder: `Search exercise ${i + 1}…`, value: ex.name, autocomplete: 'off' });
        const chooseName = (nm) => { ex.name = nm; nameInput.value = nm; resultsEl.style.display = 'none'; loadGhost(nm); };
        const listRows = (rows, q) => {
          resultsEl.innerHTML = '';
          rows.slice(0, 20).forEach((r) => resultsEl.append(
            h('div', { class: 'fs-row', onClick: () => chooseName(r.name) }, h('span', {}, r.name), h('span', { class: 'fs-tag' }, r.muscle))));
          if (q && !rows.some((r) => r.name.toLowerCase() === q.toLowerCase())) {
            resultsEl.append(h('div', { class: 'fs-row', onClick: () => chooseName(q) }, h('span', {}, `Use “${q}”`), h('span', { class: 'fs-tag' }, 'custom')));
          }
          resultsEl.style.display = resultsEl.children.length ? '' : 'none';
        };
        const showMuscles = () => {
          resultsEl.innerHTML = '';
          const chips = h('div', { class: 'chip-row', style: 'padding:9px 10px' });
          MUSCLES.forEach((m) => chips.append(h('button', { class: 'chip', type: 'button', onClick: async () => {
            try { listRows(await api(`/api/exercise-lib?muscle=${encodeURIComponent(m)}`), ''); } catch {}
          } }, m)));
          resultsEl.append(chips);
          resultsEl.style.display = '';
        };
        let t = null;
        nameInput.addEventListener('input', (e) => {
          ex.name = e.target.value; dirty = true;
          clearTimeout(t);
          t = setTimeout(async () => {
            const q = nameInput.value.trim();
            if (!q) return showMuscles();
            try { listRows(await api(`/api/exercise-lib?q=${encodeURIComponent(q)}`), q); } catch {}
          }, 200);
        });
        nameInput.addEventListener('focus', () => { if (!nameInput.value.trim()) showMuscles(); });

        block.append(h('div', { class: 'ex-head' }, nameInput,
          h('button', { class: 'x', type: 'button', 'aria-label': 'Remove exercise', onClick: () => {
            exercises.splice(i, 1);
            if (!exercises.length) exercises.push({ name: '', sets: [newSet()] });
            renderExercises();
          }, html: '&#10005;' })));
        block.append(resultsEl);

        // "last time" + PR line
        const g = ghosts[ex.name.trim()];
        if (g && (g.lastSets.length || g.pr?.max_weight)) {
          const setsTxt = g.lastSets.map((s) => (s.weight ? `${s.weight}×${s.reps}` : `${s.reps}`)).join(' · ');
          block.append(h('div', { class: 'ghost-line' },
            g.lastSets.length ? h('span', {}, `Last (${fmtDate(g.lastDate, { month: 'short', day: 'numeric' })}): ${setsTxt}`) : null,
            g.pr?.max_weight ? h('b', {}, `PR ${g.pr.max_weight} kg`) : null,
            g.pr?.best_1rm ? h('span', {}, `e1RM ${Math.round(g.pr.best_1rm)} kg`) : null,
          ));
        }

        block.append(h('div', { class: 'set-grid hdr' }, h('span', { class: 'sn' }, 'Set'), h('span', {}, 'Weight (kg)'), h('span', {}, 'Reps'), h('span', {}, live ? '✓' : '')));
        ex.sets.forEach((s, j) => {
          const gs = g?.lastSets?.[j];
          const typeBtn = h('button', { class: 'st' + (s.type !== 'normal' ? ' special' : ''), type: 'button',
            title: 'Tap: warm-up → failure → drop set', onClick: () => {
              s.type = SET_TYPES[(SET_TYPES.indexOf(s.type) + 1) % SET_TYPES.length];
              renderExercises();
            } }, s.type === 'normal' ? String(j + 1) : SET_LABEL[s.type]);
          const wIn = h('input', { type: 'number', step: '0.5', min: '0', inputmode: 'decimal', value: s.weight,
            placeholder: gs != null ? String(gs.weight) : '', onInput: (e) => { s.weight = e.target.value; dirty = true; } });
          const rIn = h('input', { type: 'number', min: '0', inputmode: 'numeric', value: s.reps,
            placeholder: gs != null ? String(gs.reps) : '', onInput: (e) => { s.reps = e.target.value; dirty = true; } });
          const lastCell = live
            ? h('button', { class: 'done-btn' + (s.done ? ' done' : ''), type: 'button', 'aria-label': 'Set done', html: '&#10003;', onClick: () => {
                s.done = !s.done; dirty = true;
                if (s.done) {
                  if (!s.weight && gs) s.weight = gs.weight; // adopt ghost values on quick-check
                  if (!s.reps && gs) s.reps = gs.reps;
                  startRest();
                }
                renderExercises();
              } })
            : h('button', { class: 'x', type: 'button', 'aria-label': 'Remove set', onClick: () => {
                ex.sets.splice(j, 1);
                if (!ex.sets.length) ex.sets.push(newSet());
                renderExercises();
              }, html: '&#10005;' });
          block.append(h('div', { class: 'set-grid' }, typeBtn, wIn, rIn, lastCell));
        });
        block.append(h('button', { class: 'add-inline', type: 'button', onClick: () => {
          const last = ex.sets[ex.sets.length - 1];
          ex.sets.push({ reps: last?.reps || '', weight: last?.weight || '', type: 'normal', done: false });
          renderExercises();
        } }, '+ Add set'));
        exWrap.append(block);
      });
      exWrap.append(h('button', { class: 'btn btn-wide', type: 'button', style: 'margin-bottom:4px', onClick: () => { exercises.push({ name: '', sets: [newSet()] }); renderExercises(); } }, '+ Add exercise'));
    }
    renderExercises();

    const collect = () => exercises
      .filter((e) => e.name.trim())
      .map((e) => ({
        name: e.name.trim(),
        sets: e.sets.filter((s) => Number(s.reps) || Number(s.weight))
          .map((s) => ({ reps: Number(s.reps) || 0, weight: Number(s.weight) || 0, type: s.type })),
      }));

    sheet.append(
      liveTop,
      h('h3', {}, isEdit ? 'Edit workout' : live ? 'Workout' : 'Log workout',
        isEdit ? h('button', { class: 'btn small danger', onClick: async () => {
          if (!confirm('Delete this workout?')) return;
          await api(`/api/workouts/${existing.id}`, { method: 'DELETE' });
          close(); toast('Workout deleted'); render();
        } }, 'Delete') : null),
      h('div', { class: 'f-row f-grid' },
        h('div', {}, h('label', {}, 'Title'), title),
        h('div', {}, h('label', {}, 'Duration (min)'), duration),
      ),
      h('div', { class: 'f-row' }, h('label', {}, 'Exercises'), exWrap),
      h('div', { class: 'f-row' }, h('label', {}, 'Photo'), photo.el),
      h('div', { class: 'f-row' }, h('label', {}, 'Notes'), notes),
      h('button', { class: 'btn small ghost', type: 'button', style: 'margin-bottom:10px', onClick: async () => {
        const items = exercises.filter((e) => e.name.trim()).map((e) => ({ exercise: e.name.trim(), sets: e.sets.length || 3 }));
        if (!items.length) return toast('Add exercises first');
        const tt = title.value.trim() || 'Routine';
        await api('/api/routines', { method: 'POST', body: { userId: state.me, title: tt, items } });
        toast(`Saved “${tt}” as a routine — find it in Train`);
      } }, 'Save as routine (reuse this workout later)'),
      h('div', { class: 'form-actions' },
        h('button', { class: 'btn ghost', onClick: () => { if (!live || !dirty || confirm('Discard this workout?')) close(); } }, 'Cancel'),
        h('button', { class: 'btn primary', onClick: async () => {
          const body = {
            userId: state.me, date: existing?.date || state.date,
            title: title.value.trim() || 'Workout',
            durationMin: Number(duration.value) || (live ? Math.max(1, Math.round((Date.now() - startedAt) / 60000)) : 0),
            notes: notes.value.trim(),
            exercises: collect(),
          };
          if (photo.getData()) body.photoData = photo.getData();
          if (photo.removed()) body.removePhoto = true;
          if (isEdit) await api(`/api/workouts/${existing.id}`, { method: 'PUT', body });
          else await api('/api/workouts', { method: 'POST', body });
          close(); toast(isEdit ? 'Workout updated' : 'Workout logged'); render();
        } }, isEdit ? 'Save changes' : 'Finish workout'),
      ),
    );
  }, { guard: () => !live || !dirty || confirm('Discard this workout?') });
}

/* ---------------- TRAIN ---------------- */
async function renderTrain(main) {
  const [workouts, routines] = await Promise.all([
    api(`/api/workouts?user=${state.me}&limit=40`),
    api(`/api/routines?user=${state.me}`),
  ]);
  main.innerHTML = '';

  main.append(h('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px' },
    h('button', { class: 'btn primary', style: 'padding:14px', onClick: () => workoutSheet(null, { live: true }) }, 'Start workout'),
    h('button', { class: 'btn', style: 'padding:14px', onClick: () => workoutSheet() }, '+ Log past workout'),
  ));

  const thisWeek = countThisWeek(workouts);
  const goals = await api(`/api/goals?user=${state.me}`);
  main.append(h('div', { class: 'tiles', style: 'grid-template-columns:1fr 1fr' },
    tile('This week', `${thisWeek}/${goals.workouts_per_week}`, thisWeek >= goals.workouts_per_week ? 'Weekly goal hit' : `${goals.workouts_per_week - thisWeek} to go`, thisWeek >= goals.workouts_per_week),
    tile('All time', String(workouts.length >= 40 ? '40+' : workouts.length), 'workouts logged'),
  ));

  // routines (saved templates → one-tap live start)
  const rCard = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, 'Routines'), h('span', { class: 'sub' }, routines.length ? 'tap to start' : '')));
  if (!routines.length) {
    rCard.append(h('div', { class: 'empty' }, 'No routines yet. Build a workout, then tap “Save as routine” — next time it starts with one tap.'));
  }
  routines.forEach((r) => {
    rCard.append(h('div', { class: 'entry', onClick: () => workoutSheet(null, { live: true, routine: r }) },
      h('div', { class: 'e-body' },
        h('div', { class: 'e-title' }, r.title),
        h('div', { class: 'e-sub' }, r.items.map((it) => `${it.sets}× ${it.exercise}`).join(' · ')),
      ),
      h('button', { class: 'x', type: 'button', 'aria-label': 'Delete routine', onClick: async (e) => {
        e.stopPropagation();
        if (!confirm(`Delete routine “${r.title}”?`)) return;
        await api(`/api/routines/${r.id}`, { method: 'DELETE' }); render();
      }, html: '&#10005;' }),
    ));
  });
  main.append(rCard);

  const list = h('div');
  if (!workouts.length) list.append(h('div', { class: 'card empty' }, h('b', {}, 'No workouts yet'), 'Log your first one — sets, reps, weight.'));

  workouts.forEach((w) => {
    const volume = w.exercises.reduce((v, e) => v + e.sets.reduce((s, x) => s + x.reps * x.weight, 0), 0);
    const card = h('div', { class: 'card wo-card', onClick: () => workoutSheet(w) },
      h('div', { class: 'card-head' },
        h('h2', {}, w.title),
        h('span', { class: 'sub' }, fmtDate(w.date, { weekday: 'short', month: 'short', day: 'numeric' })),
      ),
      w.exercises.slice(0, 6).map((e) => {
        const best = e.sets.reduce((b, s) => (s.weight * s.reps > (b ? b.weight * b.reps : -1) ? s : b), null);
        return h('div', { class: 'wo-ex' },
          h('span', { class: 'n' }, `${e.sets.length} × ${e.name}`),
          h('span', { class: 's' }, best && (best.weight || best.reps) ? `${best.weight ? best.weight + ' kg × ' : ''}${best.reps}` : ''),
        );
      }),
      w.exercises.length > 6 ? h('div', { class: 'sub' }, `+ ${w.exercises.length - 6} more`) : null,
      h('div', { class: 'wo-meta' },
        w.duration_min ? h('span', {}, `${w.duration_min} min`) : null,
        volume ? h('span', {}, `${Math.round(volume).toLocaleString()} kg volume`) : null,
        w.notes ? h('span', {}, w.notes) : null,
      ),
      w.photo ? h('img', { class: 'wo-photo', src: `/uploads/${w.photo}`, loading: 'lazy', alt: '' }) : null,
    );
    list.append(card);
  });
  main.append(list);
}

function countThisWeek(workouts) {
  const now = new Date();
  const day = (now.getDay() + 6) % 7; // Monday = 0
  const monday = addDays(todayStr(), -day);
  return workouts.filter((w) => w.date >= monday && w.date <= todayStr()).length;
}

const tile = (label, value, sub, good) =>
  h('div', { class: 'tile' },
    h('div', { class: 't-label' }, label),
    h('div', { class: 't-value' }, value),
    sub ? h('div', { class: 't-sub' + (good ? ' good' : '') }, sub) : null,
  );

/* ---------------- PROGRESS ---------------- */
async function renderProgress(main) {
  const uid = state.progressUser || state.me;
  const p = await api(`/api/progress?user=${uid}&days=${state.progressRange}&date=${todayStr()}`);

  main.innerHTML = '';

  // user + range controls
  const userSeg = h('div', { class: 'seg', style: 'margin-bottom:10px' });
  [1, 2].forEach((id) => {
    const b = h('button', { class: id === uid ? 'active' : '', onClick: () => { state.progressUser = id; render(); } }, USERS[id]);
    userSeg.append(b);
  });
  const rangeSeg = h('div', { class: 'seg range-seg' });
  [[7, '7 days'], [30, '30 days'], [90, '90 days']].forEach(([n, label]) => {
    rangeSeg.append(h('button', { class: n === state.progressRange ? 'active' : '', onClick: () => { state.progressRange = n; render(); } }, label));
  });
  main.append(userSeg, rangeSeg);

  // stat tiles
  const loggedDays = p.days.filter((d) => d.meals > 0);
  const avgCal = loggedDays.length ? Math.round(loggedDays.reduce((s, d) => s + d.calories, 0) / loggedDays.length) : 0;
  const wDelta = p.weights.length >= 2 ? round1(p.weights[p.weights.length - 1].kg - p.weights[0].kg) : null;
  const completeDays = p.days.filter((d) => d.complete).length;
  const weeks = Math.max(1, p.days.length / 7);

  main.append(h('div', { class: 'tiles' },
    tile('Streak', `${p.streak}`, p.streak === 1 ? 'day' : 'days', p.streak >= 3),
    tile('Workouts', `${p.totalWorkouts}`, `${round1(p.totalWorkouts / weeks)}/wk · goal ${p.goals.workouts_per_week}`, p.totalWorkouts / weeks >= p.goals.workouts_per_week),
    tile('Avg calories', avgCal ? String(avgCal) : '—', `goal ${p.goals.calories}`, avgCal > 0 && avgCal <= p.goals.calories),
    tile('Weight', p.weights.length ? `${p.weights[p.weights.length - 1].kg} kg` : '—',
      wDelta == null ? 'log it daily' : `${wDelta > 0 ? '+' : ''}${wDelta} kg in range`, wDelta != null && wDelta <= 0),
  ));

  // weight chart
  const wCard = h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Weight'), h('span', { class: 'sub' }, 'kg')));
  wCard.append(p.weights.length >= 2 ? lineChart(p.weights.map((w) => ({ x: w.date, y: w.kg })), { unit: ' kg' })
    : h('div', { class: 'empty' }, 'Log weight on at least 2 days to see the trend.'));
  main.append(wCard);

  // calories chart
  const cCard = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, 'Calories per day'), h('span', { class: 'sub' }, `goal ${p.goals.calories}`)));
  cCard.append(barChart(p.days, p.goals.calories));
  cCard.append(h('div', { class: 'cons-legend' },
    h('span', {}, h('i', { style: 'background:#8a8a8a' }), 'within goal'),
    h('span', {}, h('i', { style: 'background:var(--ink)' }), 'over goal'),
  ));
  main.append(cCard);

  // strength — per-exercise est. 1RM trend + PRs
  const listRes = await api(`/api/exercise-history?user=${uid}&name=`);
  const exNames = listRes.exercises || [];
  const sCard = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, 'Strength'), h('span', { class: 'sub' }, 'est. 1RM, all time')));
  if (!exNames.length) {
    sCard.append(h('div', { class: 'empty' }, 'Log a few workouts with weights to see strength trends per exercise.'));
  } else {
    const exName = exNames.includes(state.progressEx) ? state.progressEx : exNames[0];
    const sel = h('select', { class: 'plain', style: 'margin-bottom:10px', onChange: (e) => { state.progressEx = e.target.value; render(); } },
      exNames.map((n) => h('option', { value: n, selected: n === exName }, n)));
    sCard.append(sel);
    const { history } = await api(`/api/exercise-history?user=${uid}&name=${encodeURIComponent(exName)}`);
    const pts = history.filter((r) => r.est_1rm > 0).map((r) => ({ x: r.date, y: round1(r.est_1rm) }));
    if (pts.length >= 2) {
      sCard.append(lineChart(pts, { unit: ' kg' }));
      const best = history.reduce((b, r) => Math.max(b, r.top_weight || 0), 0);
      sCard.append(h('div', { class: 'cons-legend' },
        h('span', {}, h('b', {}, `Top weight: ${best} kg`)),
        h('span', {}, `Best e1RM: ${Math.round(Math.max(...history.map((r) => r.est_1rm || 0)))} kg`),
        h('span', {}, `${history.length} sessions`),
      ));
    } else {
      sCard.append(h('div', { class: 'empty' }, `Log ${exName} with weight on 2+ days to see the trend.`));
    }
  }
  main.append(sCard);

  // muscle focus — sets per muscle group in range
  const split = await api(`/api/muscle-split?user=${uid}&days=${state.progressRange}`);
  const msCard = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, 'Muscle focus'), h('span', { class: 'sub' }, `sets · last ${state.progressRange} days`)));
  if (!split.length) {
    msCard.append(h('div', { class: 'empty' }, 'No sets logged in this range yet.'));
  } else {
    const maxSets = Math.max(...split.map((r) => r.sets), 1);
    split.forEach((r) => msCard.append(h('div', { class: 'ms-row' },
      h('span', {}, r.muscle),
      h('div', { class: 'ms-bar' }, h('i', { style: `width:${Math.round((r.sets / maxSets) * 100)}%` })),
      h('span', { class: 'ms-n' }, String(r.sets)),
    )));
  }
  main.append(msCard);

  // consistency
  const consCard = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, 'Consistency'), h('span', { class: 'sub' }, `${completeDays}/${p.days.length} complete days`)));
  const grid = h('div', { class: 'cons-grid' });
  p.days.forEach((d) => {
    const cls = d.complete ? 'complete' : (d.meals > 0 || d.trained || d.rest) ? 'partial' : '';
    grid.append(h('div', { class: `cons-cell ${cls}`, title: `${fmtDate(d.date, { month: 'short', day: 'numeric' })}: ${d.complete ? 'complete' : cls ? 'partial' : 'nothing logged'}` }));
  });
  consCard.append(grid, h('div', { class: 'cons-legend' },
    h('span', {}, h('i', { style: 'background:var(--accent)' }), 'complete'),
    h('span', {}, h('i', { style: 'background:var(--accent-25)' }), 'partial'),
    h('span', {}, h('i', { style: 'background:var(--ink-08)' }), 'nothing'),
  ));
  main.append(consCard);

  // goals editor
  main.append(h('div', { class: 'section-title' }, `${USERS[uid]}'s goals`));
  main.append(goalsCard(p.goals, uid));
}

function goalsCard(g, uid) {
  const card = h('div', { class: 'card' });
  const fields = [
    ['calories', 'Daily calories', g.calories], ['protein', 'Protein (g)', g.protein],
    ['carbs', 'Carbs (g)', g.carbs], ['fat', 'Fat (g)', g.fat],
    ['workoutsPerWeek', 'Workouts / week', g.workouts_per_week],
  ];
  const inputs = {};
  const grid = h('div', { class: 'f-grid', style: 'grid-template-columns:1fr 1fr 1fr' });
  fields.forEach(([key, label, val]) => {
    inputs[key] = h('input', { type: 'number', min: '0', value: val });
    grid.append(h('div', { class: 'f-row', style: 'margin-bottom:4px' }, h('label', {}, label), inputs[key]));
  });
  card.append(grid, h('button', { class: 'btn btn-wide', style: 'margin-top:8px', onClick: async () => {
    const body = { userId: uid };
    for (const k of Object.keys(inputs)) body[k] = Number(inputs[k].value) || 0;
    await api('/api/goals', { method: 'PUT', body });
    toast('Goals updated'); render();
  } }, 'Save goals'));
  return card;
}

/* ---------------- charts (single-series, grayscale) ---------------- */
const CHART = { w: 640, h: 230, pad: { t: 14, r: 12, b: 26, l: 40 } };

function niceTicks(min, max, count = 4) {
  const span = max - min || 1;
  const step = Math.pow(10, Math.floor(Math.log10(span / count)));
  const err = (span / count) / step;
  const mult = err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1;
  const s = step * mult;
  const ticks = [];
  for (let v = Math.ceil(min / s) * s; v <= max + 1e-9; v += s) ticks.push(round1(v));
  return ticks;
}

function chartFrame(yTicks, yScale) {
  const { w, pad } = CHART;
  const parts = [];
  for (const t of yTicks) {
    const y = yScale(t);
    parts.push(`<line x1="${pad.l}" x2="${w - pad.r}" y1="${y}" y2="${y}" stroke="rgba(46,46,46,0.08)" stroke-width="1"/>`);
    parts.push(`<text x="${pad.l - 7}" y="${y + 3.5}" text-anchor="end" font-size="10.5" fill="rgba(46,46,46,0.45)">${t}</text>`);
  }
  return parts.join('');
}

function lineChart(points, { unit = '' } = {}) {
  const { w, h: hh, pad } = CHART;
  const ys = points.map((p) => p.y);
  let yMin = Math.min(...ys), yMax = Math.max(...ys);
  const padY = Math.max((yMax - yMin) * 0.15, 0.5);
  yMin -= padY; yMax += padY;
  const x = (i) => pad.l + (i / Math.max(1, points.length - 1)) * (w - pad.l - pad.r);
  const y = (v) => pad.t + (1 - (v - yMin) / (yMax - yMin)) * (hh - pad.t - pad.b);

  const ticks = niceTicks(yMin, yMax);
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.y).toFixed(1)}`).join('');
  const first = points[0], last = points[points.length - 1];

  const svg = h('div', { class: 'chart-wrap' });
  svg.innerHTML = `<svg viewBox="0 0 ${w} ${hh}" role="img" aria-label="Weight over time">
    ${chartFrame(ticks, y)}
    <line x1="${pad.l}" x2="${w - pad.r}" y1="${hh - pad.b}" y2="${hh - pad.b}" stroke="rgba(46,46,46,0.25)" stroke-width="1"/>
    <path d="${path}" fill="none" stroke="#2e2e2e" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    ${points.map((p, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(p.y).toFixed(1)}" r="3.5" fill="#2e2e2e" stroke="#fff" stroke-width="1.5" data-i="${i}"/>`).join('')}
    <text x="${x(0)}" y="${hh - pad.b + 16}" font-size="10.5" fill="rgba(46,46,46,0.45)" text-anchor="start">${fmtDate(first.x, { month: 'short', day: 'numeric' })}</text>
    <text x="${x(points.length - 1)}" y="${hh - pad.b + 16}" font-size="10.5" fill="rgba(46,46,46,0.45)" text-anchor="end">${fmtDate(last.x, { month: 'short', day: 'numeric' })}</text>
    <text x="${x(points.length - 1) - 8}" y="${y(last.y) - 9}" font-size="11" font-weight="700" fill="rgba(46,46,46,0.85)" text-anchor="end">${last.y}${unit}</text>
  </svg>`;
  attachTip(svg, (mx) => {
    const rect = svg.querySelector('svg').getBoundingClientRect();
    const rel = ((mx - rect.left) / rect.width) * w;
    let best = 0, bd = Infinity;
    points.forEach((p, i) => { const d = Math.abs(x(i) - rel); if (d < bd) { bd = d; best = i; } });
    const p = points[best];
    return { px: (x(best) / w) * rect.width, py: (y(p.y) / hh) * rect.height, text: `${fmtDate(p.x, { month: 'short', day: 'numeric' })} · ${p.y}${unit}` };
  });
  return svg;
}

function barChart(days, goal) {
  const { w, h: hh, pad } = CHART;
  const vals = days.map((d) => d.calories);
  const yMax = Math.max(goal * 1.15, ...vals, 100);
  const y = (v) => pad.t + (1 - v / yMax) * (hh - pad.t - pad.b);
  const iw = (w - pad.l - pad.r) / days.length;
  const bw = Math.max(2, Math.min(26, iw - 2));
  const x = (i) => pad.l + i * iw + (iw - bw) / 2;
  const ticks = niceTicks(0, yMax);
  const baseline = hh - pad.b;

  const bars = days.map((d, i) => {
    if (!d.calories) return '';
    const top = y(d.calories);
    const ht = Math.max(2, baseline - top);
    const fill = d.calories > goal ? '#2e2e2e' : '#8a8a8a';
    const r = Math.min(4, bw / 2, ht);
    return `<path d="M${x(i)},${baseline} v${-(ht - r)} a${r},${r} 0 0 1 ${r},${-r} h${bw - 2 * r} a${r},${r} 0 0 1 ${r},${r} v${ht - r} z" fill="${fill}" data-i="${i}"/>`;
  }).join('');

  const gy = y(goal);
  const svg = h('div', { class: 'chart-wrap' });
  svg.innerHTML = `<svg viewBox="0 0 ${w} ${hh}" role="img" aria-label="Calories per day vs goal">
    ${chartFrame(ticks, y)}
    <line x1="${pad.l}" x2="${w - pad.r}" y1="${baseline}" y2="${baseline}" stroke="rgba(46,46,46,0.25)" stroke-width="1"/>
    ${bars}
    <line x1="${pad.l}" x2="${w - pad.r}" y1="${gy}" y2="${gy}" stroke="rgba(46,46,46,0.55)" stroke-width="1.5" stroke-dasharray="5 4"/>
    <text x="${w - pad.r}" y="${gy - 5}" font-size="10.5" font-weight="700" fill="rgba(46,46,46,0.6)" text-anchor="end">goal</text>
    <text x="${pad.l}" y="${hh - pad.b + 16}" font-size="10.5" fill="rgba(46,46,46,0.45)">${fmtDate(days[0].date, { month: 'short', day: 'numeric' })}</text>
    <text x="${w - pad.r}" y="${hh - pad.b + 16}" font-size="10.5" fill="rgba(46,46,46,0.45)" text-anchor="end">${fmtDate(days[days.length - 1].date, { month: 'short', day: 'numeric' })}</text>
  </svg>`;
  attachTip(svg, (mx) => {
    const rect = svg.querySelector('svg').getBoundingClientRect();
    const rel = ((mx - rect.left) / rect.width) * w;
    const i = Math.min(days.length - 1, Math.max(0, Math.floor((rel - pad.l) / iw)));
    const d = days[i];
    if (!d) return null;
    return {
      px: ((x(i) + bw / 2) / w) * rect.width,
      py: (y(d.calories || 0) / hh) * rect.height,
      text: `${fmtDate(d.date, { month: 'short', day: 'numeric' })} · ${d.calories || 0} kcal`,
    };
  });
  return svg;
}

function attachTip(wrap, locate) {
  const tip = h('div', { class: 'chart-tip' });
  wrap.append(tip);
  const svg = wrap.querySelector('svg');
  function move(e) {
    const pt = e.touches ? e.touches[0] : e;
    const res = locate(pt.clientX);
    if (!res) return hide();
    tip.textContent = res.text;
    tip.style.left = `${res.px}px`;
    tip.style.top = `${Math.max(28, res.py)}px`;
    tip.classList.add('show');
  }
  const hide = () => tip.classList.remove('show');
  svg.addEventListener('pointermove', move);
  svg.addEventListener('pointerdown', move);
  svg.addEventListener('pointerleave', hide);
}

/* ---------------- router ---------------- */
const VIEWS = { today: renderToday, food: renderFood, train: renderTrain, progress: renderProgress };

let rendering = false, renderQueued = false;
async function render() {
  if (rendering) { renderQueued = true; return; }
  rendering = true;
  renderShell();
  const main = $('#main');
  try {
    await VIEWS[state.tab](main);
  } catch (err) {
    main.innerHTML = '';
    main.append(h('div', { class: 'card empty' }, h('b', {}, 'Something went wrong'), err.message));
  } finally {
    rendering = false;
    if (renderQueued) { renderQueued = false; render(); }
  }
}

// keep shared data fresh: refresh when returning to the app, and every 60s on Today
document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });
setInterval(() => { if (!document.hidden && state.tab === 'today' && !$('#sheetRoot').children.length) render(); }, 60000);

render();
api('/api/health').then((hc) => { state.ai = !!hc.ai; }).catch(() => {});
