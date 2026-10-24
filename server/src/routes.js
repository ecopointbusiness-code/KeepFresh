import crypto from 'node:crypto';
import { all, get, run, insert, tx } from './db.js';
import { route, HttpError, bad, signToken, hashPassword, checkPassword, randomCode, randomKey, iso, today, daysLeft, daysBetween, limit } from './util.js';
import { decorate, COLOR, LEVELS } from './levels.js';
import { predictExpiry, guessCategory } from './predict.js';
import { aiEnabled, suggestRecipes } from './ai.js';
import { offlineRecipeSuggestions } from './offline-recipes.js';
import { checkHousehold, settingsOf } from './checker.js';
import { deliver, sendEmail, pushEnabled, mailEnabled } from './notify.js';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const clean = (s, max = 120) => String(s ?? '').trim().slice(0, max);
const audit = (uid, action) => run('INSERT INTO audit_logs (user_id, action) VALUES (?,?)', uid, action);
const publicUser = (u) => ({ id: u.id, firstName: u.first_name || u.name.split(' ')[0], lastName: u.last_name || '', middleName: u.middle_name || '', name: u.name, email: u.email, role: u.role, householdId: u.household_id });
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const isOnline = (ts) => !!ts && Date.now() - new Date(ts).getTime() < 5 * 60 * 1000;

/* ------------------------------------------------------------------ email codes (sent ONLY by email) */
async function issueCode(user, purpose) {
  const code = String(crypto.randomInt(100000, 1000000));
  await run('DELETE FROM email_codes WHERE user_id=? AND purpose=?', user.id, purpose);
  await run('INSERT INTO email_codes (user_id,purpose,code_hash,expires) VALUES (?,?,?,?)', user.id, purpose, sha(code), Date.now() + 15 * 60 * 1000);
  const verify = purpose === 'verify';
  const sent = await sendEmail(user, verify ? 'Your KeepFresh verification code' : 'Your KeepFresh password reset code',
    verify ? `Welcome to KeepFresh, ${user.first_name || user.name}! Your verification code is ${code}. It expires in 15 minutes.`
           : `Your KeepFresh password reset code is ${code}. It expires in 15 minutes. If you did not ask for this, you can ignore this email.`,
    { type: verify ? 'verification' : 'password_reset', code });
  if (!sent) { await run('DELETE FROM email_codes WHERE user_id=? AND purpose=?', user.id, purpose); throw new HttpError(503, 'We could not send the email right now. Please try again in a moment.'); }
}
async function checkCode(user, purpose, code) {
  const row = await get('SELECT * FROM email_codes WHERE user_id=? AND purpose=?', user.id, purpose);
  if (!row || Number(row.expires) < Date.now()) throw bad('That code has expired. Request a new one.');
  if (row.attempts >= 5) throw new HttpError(429, 'Too many wrong codes. Request a new one.');
  if (sha(clean(code, 10)) !== row.code_hash) { await run('UPDATE email_codes SET attempts=attempts+1 WHERE id=?', row.id); throw bad('Incorrect code.'); }
  await run('DELETE FROM email_codes WHERE id=?', row.id);
}
const needMail = (type = 'verification') => { if (!mailEnabled(type)) throw new HttpError(503, 'Email is not set up on this server yet, so accounts cannot be verified. Please contact the administrator.'); };

/* ------------------------------------------------------------------ auth (public) */
route('POST', '/api/auth/register', null, async (c) => {
  limit('reg:' + c.ip, 20); needMail('verification');
  const first = clean(c.body.firstName, 40), last = clean(c.body.lastName, 40), middle = clean(c.body.middleName, 40);
  const name = [first, middle, last].filter(Boolean).join(' '), email = clean(c.body.email).toLowerCase(), pw = String(c.body.password || '');
  if (!first) throw bad('Please enter your first name.');
  if (!last) throw bad('Please enter your last name.');
  if (!EMAIL.test(email)) throw bad('Please enter a valid email address.');
  if (pw.length < 8) throw bad('Password must be at least 8 characters.');
  const existing = await get('SELECT * FROM users WHERE email=?', email);
  if (existing?.verified) throw new HttpError(409, 'That email is already registered. Please log in.');
  if (existing) { await run('DELETE FROM settings WHERE user_id=?', existing.id); await run('DELETE FROM users WHERE id=?', existing.id); } // unfinished sign-up: start over
  let hid; const invite = clean(c.body.inviteCode, 20).toUpperCase();
  if (invite) { const h = await get('SELECT id FROM households WHERE invite_code=?', invite); if (!h) throw bad('That invite code was not found.'); hid = h.id; }
  const user = await tx(async () => {
    if (!hid) hid = await insert('INSERT INTO households (name, invite_code) VALUES (?,?)', clean(c.body.householdName, 60) || `${first}’s household`, randomCode(6));
    const id = await insert('INSERT INTO users (name,first_name,last_name,middle_name,email,password_hash,role,verified,household_id) VALUES (?,?,?,?,?,?,?,0,?)', name, first, last, middle || null, email, hashPassword(pw), 'user', hid);
    await run('INSERT INTO settings (user_id) VALUES (?)', id);
    return get('SELECT * FROM users WHERE id=?', id);
  });
  await issueCode(user, 'verify');
  c.status = 201;
  return { needsVerification: true, email };
});

route('POST', '/api/auth/verify', null, async (c) => {
  limit('ver:' + c.ip, 30);
  const user = await get("SELECT * FROM users WHERE email=? AND role='user'", clean(c.body.email).toLowerCase());
  if (!user) throw bad('Incorrect code.');
  if (user.verified) throw bad('This email is already verified. Please log in.');
  await checkCode(user, 'verify', c.body.code);
  await run('UPDATE users SET verified=1 WHERE id=?', user.id);
  return { token: signToken({ uid: user.id, role: 'user' }), user: publicUser({ ...user, verified: 1 }) };
});

route('POST', '/api/auth/resend', null, async (c) => {
  limit('res:' + c.ip, 10); needMail('verification');
  const user = await get("SELECT * FROM users WHERE email=? AND role='user' AND verified=0", clean(c.body.email).toLowerCase());
  if (user) await issueCode(user, 'verify');
  return { ok: true };
});

route('POST', '/api/auth/login', null, async (c) => {
  limit('login:' + c.ip, 15);
  const user = await get("SELECT * FROM users WHERE email=? AND role='user'", clean(c.body.email).toLowerCase());
  if (!user || !checkPassword(String(c.body.password || ''), user.password_hash)) throw new HttpError(401, 'Incorrect email or password.');
  if (!user.active) throw new HttpError(403, 'This account has been suspended. Please contact support.');
  if (!user.verified) { needMail('verification'); await issueCode(user, 'verify'); throw new HttpError(403, 'Please verify your email first. We sent you a new code.', { needsVerification: true, email: user.email }); }
  return { token: signToken({ uid: user.id, role: 'user' }), user: publicUser(user) };
});

route('POST', '/api/auth/forgot', null, async (c) => {
  limit('forgot:' + c.ip, 10); needMail('password_reset');
  const user = await get("SELECT * FROM users WHERE email=? AND role='user' AND verified=1 AND active=1", clean(c.body.email).toLowerCase());
  if (user) await issueCode(user, 'reset');
  return { ok: true };
});

route('POST', '/api/auth/reset', null, async (c) => {
  limit('reset:' + c.ip, 15);
  const user = await get("SELECT * FROM users WHERE email=? AND role='user'", clean(c.body.email).toLowerCase());
  if (!user) throw bad('Incorrect code.');
  if (String(c.body.password || '').length < 8) throw bad('Password must be at least 8 characters.');
  await checkCode(user, 'reset', c.body.code);
  await run('UPDATE users SET password_hash=? WHERE id=?', hashPassword(c.body.password), user.id);
  return { ok: true };
});

/* ------------------------------------------------------------------ profile, settings, push */
route('GET', '/api/me', 'user', async (c) => {
  const u = c.user, h = await get('SELECT * FROM households WHERE id=?', u.household_id);
  return { user: publicUser(u), household: { id: h.id, name: h.name, inviteCode: h.invite_code, members: await all("SELECT id,name FROM users WHERE household_id=? AND role='user'", h.id) },
    settings: await settingsOf(u.id), emailEnabled: mailEnabled(), pushEnabled: pushEnabled(), aiEnabled: aiEnabled() };
});
route('PUT', '/api/settings', 'user', async (c) => {
  const b = c.body, n = (v, lo, hi, d) => Math.max(lo, Math.min(hi, Number.isFinite(+v) ? Math.round(+v) : d));
  const cur = await settingsOf(c.user.id);
  const watch = n(b.watch_days ?? cur.watch_days, 1, 14, 3), warn = Math.min(n(b.warn_days ?? cur.warn_days, 0, 7, 1), watch);
  await run('UPDATE settings SET watch_days=?, warn_days=?, email_on=?, push_on=? WHERE user_id=?', watch, warn, (b.email_on ?? cur.email_on) ? 1 : 0, (b.push_on ?? cur.push_on) ? 1 : 0, c.user.id);
  await run('DELETE FROM alert_state WHERE user_id=?', c.user.id);
  checkHousehold(c.user.household_id).catch(() => {});
  return settingsOf(c.user.id);
});
route('GET', '/api/push/key', 'user', async () => ({ key: process.env.VAPID_PUBLIC_KEY || null }));
route('POST', '/api/push/subscribe', 'user', async (c) => {
  const s = c.body.subscription; if (!s?.endpoint) throw bad('Invalid subscription.');
  await run('INSERT INTO push_subs (user_id,endpoint,data) VALUES (?,?,?) ON CONFLICT (endpoint) DO UPDATE SET user_id=excluded.user_id, data=excluded.data', c.user.id, s.endpoint, JSON.stringify(s));
  return { ok: true };
});

/* ------------------------------------------------------------------ inventory */
const hid = (c) => c.user.household_id;
route('GET', '/api/catalog', 'user', () => all('SELECT category, shelf_days, emoji FROM food_catalog ORDER BY id'));
route('GET', '/api/items', 'user', async (c) => { const cfg = await settingsOf(c.user.id); return (await all('SELECT * FROM items WHERE household_id=? ORDER BY expires', hid(c))).map((i) => decorate(i, cfg)); });
route('POST', '/api/predict', 'user', async (c) => {
  limit('predict-ai:' + c.user.id, 30, 60 * 60 * 1000);
  const category = clean(c.body.category) === 'Other' ? guessCategory(clean(c.body.name)) : clean(c.body.category);
  return predictExpiry(hid(c), category, clean(c.body.bought) || iso(today()), clean(c.body.name));
});
route('POST', '/api/items', 'user', async (c) => {
  const b = c.body, name = clean(b.name, 80); if (!name) throw bad('Please enter the item name.');
  const requestedCategory = clean(b.category), category = !requestedCategory || requestedCategory === 'Other' ? guessCategory(name) : requestedCategory, bought = clean(b.bought) || iso(today());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(bought)) throw bad('Invalid date bought.');
  let expires = clean(b.expires), predicted = 0, confidence = null, predictionSource = 'manual';
  if (!expires && b.prediction && /^\d{4}-\d{2}-\d{2}$/.test(b.prediction.expires || '')) { expires = b.prediction.expires; predicted = 1; confidence = Math.max(0, Math.min(1, Number(b.prediction.confidence) || 0)); predictionSource = ['AI', 'household history', 'reference'].includes(b.prediction.source) ? b.prediction.source : 'reference'; }
  if (expires && !/^\d{4}-\d{2}-\d{2}$/.test(expires)) throw bad('Invalid expiration date.');
  if (!expires) { const p = await predictExpiry(hid(c), category, bought, name); expires = p.expires; predicted = 1; confidence = p.confidence; predictionSource = p.source; }
  const id = await insert('INSERT INTO items (household_id,name,category,qty,bought,expires,predicted,confidence,prediction_source,added_by) VALUES (?,?,?,?,?,?,?,?,?,?)', hid(c), name, category, clean(b.qty, 40) || '1', bought, expires, predicted, confidence, predictionSource, c.user.id);
  await checkHousehold(hid(c)); c.status = 201;
  return decorate(await get('SELECT * FROM items WHERE id=?', id), await settingsOf(c.user.id));
});
route('PATCH', '/api/items/:id', 'user', async (c) => {
  const it = await get('SELECT * FROM items WHERE id=? AND household_id=?', c.params.id, hid(c)); if (!it) throw new HttpError(404, 'Item not found.');
  const b = c.body, exp = clean(b.expires) || it.expires;
  await run('UPDATE items SET name=?, qty=?, category=?, expires=?, predicted=?, prediction_source=? WHERE id=?', clean(b.name, 80) || it.name, clean(b.qty, 40) || it.qty, clean(b.category) || it.category, exp, b.expires ? 0 : it.predicted, b.expires ? 'manual' : it.prediction_source, it.id);
  await run('DELETE FROM alert_state WHERE item_id=?', it.id); await checkHousehold(hid(c));
  return decorate(await get('SELECT * FROM items WHERE id=?', it.id), await settingsOf(c.user.id));
});
async function removeItem(it, outcome) {
  await run('INSERT INTO consumption_logs (household_id,category,days,outcome) VALUES (?,?,?,?)', it.household_id, it.category, Math.max(1, daysBetween(it.bought, iso(today()))), outcome);
  await run('DELETE FROM items WHERE id=?', it.id);
}
route('DELETE', '/api/items/:id', 'user', async (c) => {
  const it = await get('SELECT * FROM items WHERE id=? AND household_id=?', c.params.id, hid(c)); if (!it) throw new HttpError(404, 'Item not found.');
  await removeItem(it, c.query.get('outcome') === 'discarded' ? 'discarded' : 'consumed'); return { ok: true };
});

/* ------------------------------------------------------------------ alerts */
route('GET', '/api/alerts', 'user', async (c) => ({ alerts: (await all('SELECT * FROM alerts WHERE user_id=? ORDER BY id DESC LIMIT 50', c.user.id)).map((a) => ({ ...a, color: COLOR[a.level] })), unread: (await get('SELECT COUNT(*) n FROM alerts WHERE user_id=? AND acked=0', c.user.id)).n }));
route('POST', '/api/alerts/ack-all', 'user', async (c) => { await run('UPDATE alerts SET acked=1 WHERE user_id=?', c.user.id); return { ok: true }; });

/* ------------------------------------------------------------------ recipes */
function ingredientMatches(key, item) {
  const term = key.toLowerCase().trim().replace(/[^a-z0-9]+/g, ' '), name = item.name.toLowerCase().trim().replace(/[^a-z0-9]+/g, ' '), category = item.category;
  if (name === term) return true;
  const inferred = guessCategory(term);
  if (inferred !== 'Other') return inferred === category;
  return (' ' + name + ' ').includes(' ' + term + ' ');
}
async function rankRecipes(c) {
  const cfg = await settingsOf(c.user.id), items = (await all('SELECT * FROM items WHERE household_id=?', hid(c))).map((i) => decorate(i, cfg)).filter((i) => i.daysLeft >= 0);
  const out = [];
  // Recommendations are generated by AI or curated by an administrator; the old bundled demo catalog is intentionally not shown.
  for (const r of await all('SELECT * FROM recipes WHERE published=1 AND custom=1 AND (household_id IS NULL OR household_id=?)', hid(c))) {
    const ings = (await all('SELECT key, amount FROM recipe_ings WHERE recipe_id=? ORDER BY id', r.id)).map((g) => ({ ...g, have: items.some((it) => ingredientMatches(g.key, it)), soon: items.some((it) => ingredientMatches(g.key, it) && it.daysLeft <= cfg.watch_days) }));
    // A dish only appears when its first (anchor) ingredient is actually in this household's refrigerator.
    if (!ings.length || !ings[0].have) continue;
    out.push({ id: r.id, name: r.name, emoji: r.emoji, color: r.color, time: r.time, servings: r.servings, steps: JSON.parse(r.steps), ingredients: ings, ready: ings.filter((g) => g.have).length, total: ings.length, soon: ings.filter((g) => g.soon).map((g) => g.key), aiGenerated: !!r.ai_generated });
  }
  return out.sort((a, b) => b.soon.length - a.soon.length || b.ready / b.total - a.ready / a.total);
}
route('GET', '/api/recipes', 'user', (c) => rankRecipes(c));
route('POST', '/api/recipes/suggest', 'user', async (c) => {
  limit('recipe-suggest:' + c.user.id, 12, 60 * 60 * 1000);
  const inventory = (await all('SELECT * FROM items WHERE household_id=?', hid(c))).filter((i) => daysLeft(i.expires) >= 0);
  if (!inventory.length) throw bad('Add at least one fresh ingredient to your refrigerator first.');
  let generated, generatedByAi = false;
  if (aiEnabled()) {
    try {
      const answer = await suggestRecipes(inventory.map((i) => ({ name: i.name, category: i.category, quantity: i.qty, daysLeft: daysLeft(i.expires) })));
      generated = Array.isArray(answer?.recipes) ? answer.recipes.slice(0, 4) : [];
      generatedByAi = true;
    } catch (e) {
      console.warn('[recipes] AI unavailable; using curated fridge matches:', e.message);
      generated = offlineRecipeSuggestions(inventory.map((i) => ({ name: i.name, category: i.category, qty: i.qty, daysLeft: daysLeft(i.expires) })));
    }
  } else {
    generated = offlineRecipeSuggestions(inventory.map((i) => ({ name: i.name, category: i.category, qty: i.qty, daysLeft: daysLeft(i.expires) })));
  }
  const colors = ['#fde3e3', '#fff0c9', '#dff5e3', '#dcedfb']; let saved = 0;
  for (const item of generated) {
    const name = clean(item.name, 80), anchor = clean(item.anchor, 80);
    const anchorItem = inventory.find((i) => i.name.toLowerCase() === anchor.toLowerCase());
    const steps = Array.isArray(item.steps) ? item.steps.map((x) => clean(x, 600)).filter(Boolean).slice(0, 12) : [];
    if (!name || !anchorItem || steps.length < 3) continue;
    const rawIngredients = Array.isArray(item.ingredients) ? item.ingredients : [];
    const ingredients = rawIngredients.map((g) => ({ key: clean(g.key, 80), amount: clean(g.amount, 100) })).filter((g) => g.key).slice(0, 24);
    if (!ingredients.some((g) => g.key.toLowerCase() === anchor.toLowerCase())) ingredients.unshift({ key: anchor, amount: anchorItem.qty || 'to taste' });
    else ingredients.sort((a, b) => Number(b.key.toLowerCase() === anchor.toLowerCase()) - Number(a.key.toLowerCase() === anchor.toLowerCase()));
    const current = await get('SELECT id FROM recipes WHERE lower(name)=lower(?) AND custom=1 AND household_id=?', name, hid(c));
    let id;
    if (current) {
      id = current.id;
      await run('UPDATE recipes SET emoji=?,color=?,time=?,servings=?,steps=?,published=1,ai_generated=? WHERE id=?', clean(item.emoji, 8) || '🍽️', colors[saved % colors.length], clean(item.time, 20) || '35 min', Math.max(1, Math.min(12, Math.round(+item.servings || 4))), JSON.stringify(steps), generatedByAi ? 1 : 0, id);
      await run('DELETE FROM recipe_ings WHERE recipe_id=?', id);
    } else id = await insert('INSERT INTO recipes (name,emoji,color,time,servings,steps,published,custom,ai_generated,household_id) VALUES (?,?,?,?,?,?,1,1,?,?)', name, clean(item.emoji, 8) || '🍽️', colors[saved % colors.length], clean(item.time, 20) || '35 min', Math.max(1, Math.min(12, Math.round(+item.servings || 4))), JSON.stringify(steps), generatedByAi ? 1 : 0, hid(c));
    for (const g of ingredients) await run('INSERT INTO recipe_ings (recipe_id,key,amount) VALUES (?,?,?)', id, g.key, g.amount || g.key);
    saved++;
  }
  return { generated: saved };
});
route('POST', '/api/recipes/:id/cook', 'user', async (c) => {
  const recipe = await get('SELECT id FROM recipes WHERE id=? AND published=1 AND custom=1 AND (household_id IS NULL OR household_id=?)', c.params.id, hid(c));
  if (!recipe) throw new HttpError(404, 'Recipe not found.');
  const ings = await all('SELECT key FROM recipe_ings WHERE recipe_id=?', c.params.id), per = ['Poultry', 'Ground meat', 'Pork or beef cuts', 'Fish & seafood', 'Leafy vegetables'];
  let used = 0;
  for (const g of ings) {
    const it = (await all('SELECT * FROM items WHERE household_id=? ORDER BY expires', hid(c))).find((i) => per.includes(i.category) && daysLeft(i.expires) >= 0 && i.name.toLowerCase().includes(g.key));
    if (it) { await removeItem(it, 'consumed'); used++; }
  }
  return { used };
});

/* ------------------------------------------------------------------ grocery */
async function suggestions(c) {
  const have = new Set((await all('SELECT name FROM grocery WHERE household_id=?', hid(c))).map((g) => g.name.toLowerCase())), s = new Map();
  for (const r of (await rankRecipes(c)).slice(0, 3)) for (const g of r.ingredients) if (!g.have && !have.has(g.key)) s.set(g.key, { name: g.key, qty: g.amount, why: r.name });
  for (const it of await all('SELECT * FROM items WHERE household_id=?', hid(c))) if (daysLeft(it.expires) < 0 && !have.has(it.name.toLowerCase())) s.set(it.name.toLowerCase(), { name: it.name.toLowerCase(), qty: it.qty, why: 'replace expired item' });
  return [...s.values()];
}
const addGrocery = async (h, g) => { if (!(await get('SELECT 1 x FROM grocery WHERE household_id=? AND lower(name)=lower(?)', h, g.name))) await run('INSERT INTO grocery (household_id,name,qty,why) VALUES (?,?,?,?)', h, g.name, g.qty || '', g.why || ''); };
route('GET', '/api/grocery', 'user', async (c) => ({ list: (await all('SELECT * FROM grocery WHERE household_id=? ORDER BY done, id', hid(c))).map((g) => ({ ...g, done: !!g.done, category: guessCategory(g.name) })), suggestions: await suggestions(c) }));
route('POST', '/api/grocery', 'user', async (c) => { const name = clean(c.body.name, 80).toLowerCase(); if (!name) throw bad('Please enter an item.'); await addGrocery(hid(c), { name, qty: clean(c.body.qty, 40), why: clean(c.body.why, 80) || 'added by you' }); c.status = 201; return { ok: true }; });
route('PATCH', '/api/grocery/:id', 'user', async (c) => { await run('UPDATE grocery SET done=? WHERE id=? AND household_id=?', c.body.done ? 1 : 0, c.params.id, hid(c)); return { ok: true }; });
route('DELETE', '/api/grocery/:id', 'user', async (c) => { await run('DELETE FROM grocery WHERE id=? AND household_id=?', c.params.id, hid(c)); return { ok: true }; });
route('POST', '/api/grocery/add-suggested', 'user', async (c) => { for (const g of await suggestions(c)) await addGrocery(hid(c), g); return { ok: true }; });
route('POST', '/api/grocery/add-missing', 'user', async (c) => { const r = (await rankRecipes(c)).find((x) => x.id === +c.body.recipeId); if (!r) throw new HttpError(404, 'Recipe not found.'); for (const g of r.ingredients.filter((x) => !x.have)) await addGrocery(hid(c), { name: g.key, qty: g.amount, why: r.name }); return { ok: true }; });
route('POST', '/api/grocery/clear-checked', 'user', async (c) => { await run('DELETE FROM grocery WHERE household_id=? AND done=1', hid(c)); return { ok: true }; });
route('POST', '/api/grocery/move-bought', 'user', async (c) => {
  const done = await all('SELECT * FROM grocery WHERE household_id=? AND done=1', hid(c));
  await tx(async () => { for (const g of done) {
    const cat = guessCategory(g.name), bought = iso(today()), p = await predictExpiry(hid(c), cat, bought, g.name);
    await run('INSERT INTO items (household_id,name,category,qty,bought,expires,predicted,confidence,prediction_source,added_by) VALUES (?,?,?,?,?,?,1,?,?,?)', hid(c), g.name[0].toUpperCase() + g.name.slice(1), cat, g.qty || '1', bought, p.expires, p.confidence, p.source, c.user.id);
    await run('DELETE FROM grocery WHERE id=?', g.id);
  } });
  await checkHousehold(hid(c)); return { moved: done.length };
});

/* ------------------------------------------------------------------ household and devices */
route('GET', '/api/household', 'user', async (c) => ({ devices: (await all('SELECT id, code, fw, last_seen FROM devices WHERE household_id=?', hid(c))).map((d) => ({ ...d, online: isOnline(d.last_seen) })) }));
route('POST', '/api/household/device', 'user', async (c) => {
  const d = await get('SELECT * FROM devices WHERE code=?', clean(c.body.code, 20).toUpperCase());
  if (!d) throw bad('Device code not found.'); if (d.household_id && d.household_id !== hid(c)) throw bad('That device is already linked to another household.');
  await run('UPDATE devices SET household_id=? WHERE id=?', hid(c), d.id); return { ok: true };
});

route('GET', '/api/device/status', 'device', async (c) => {
  const d = c.device; await run('UPDATE devices SET last_seen=? WHERE id=?', new Date().toISOString(), d.id);
  const owner = d.household_id && await get("SELECT id FROM users WHERE household_id=? AND role='user' AND active=1 ORDER BY id LIMIT 1", d.household_id);
  const cfg = owner ? await settingsOf(owner.id) : { watch_days: 3, warn_days: 1 };
  const all_ = (d.household_id ? await all('SELECT * FROM items WHERE household_id=?', d.household_id) : []).map((i) => decorate(i, cfg));
  const items = all_.filter((i) => i.level !== 'Advisory').sort((a, b) => a.daysLeft - b.daysLeft);
  const worst = items.some((i) => i.level === 'Critical') ? 'red' : items.length ? 'yellow' : 'green';
  const last = await get('SELECT led FROM device_logs WHERE device_id=? ORDER BY id DESC LIMIT 1', d.id);
  if (last?.led !== worst) await run('INSERT INTO device_logs (device_id,led,message) VALUES (?,?,?)', d.id, worst, items.slice(0, 4).map((i) => i.name).join(', '));
  const command = d.command || null; if (command) await run('UPDATE devices SET command=NULL WHERE id=?', d.id);

  // Extra information for the unit's screen
  const house = d.household_id ? await get('SELECT name FROM households WHERE id=?', d.household_id) : null;
  const count = (l) => all_.filter((i) => i.level === l).length;
  let tip = '';                       // a recipe that uses something that is about to spoil
  const urgent = items.filter((i) => i.daysLeft >= 0);
  if (urgent.length) for (const r of await all('SELECT id, name FROM recipes WHERE published=1 AND custom=1 AND (household_id IS NULL OR household_id=?) ORDER BY id', d.household_id)) {
    const keys = (await all('SELECT key FROM recipe_ings WHERE recipe_id=?', r.id)).map((g) => g.key);
    const hit = urgent.find((it) => keys.some((k) => it.name.toLowerCase().includes(k) || it.category.toLowerCase().includes(k)));
    if (hit) { tip = `${r.name} (uses ${hit.name})`; break; }
  }
  const cutoff = new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 19).replace('T', ' ');
  const adv = await get("SELECT message FROM announcements WHERE (audience='all' OR audience=?) AND created_at>=? ORDER BY id DESC LIMIT 1", d.household_id ? `household:${d.household_id}` : 'all', cutoff);
  return { led: worst, buzzer: worst === 'red', count: items.length, command,
    household: house?.name || '', linked: !!d.household_id, code: d.code, total: all_.length,
    counts: { fresh: count('Advisory'), watch: count('Watch'), warning: count('Warning'), critical: count('Critical') },
    items: items.slice(0, 6).map((i) => ({ name: i.name, days: i.daysLeft, level: i.level, qty: i.qty })),
    tip, advisory: adv?.message || '' };
});

/* ------------------------------------------------------------------ admin (separate login, role enforced) */
route('POST', '/api/admin/login', null, async (c) => {
  limit('admin:' + c.ip, 8);
  const u = await get("SELECT * FROM users WHERE email=? AND role='admin' AND active=1", clean(c.body.email).toLowerCase());
  if (!u || !checkPassword(String(c.body.password || ''), u.password_hash)) throw new HttpError(401, 'Incorrect email or password.');
  await audit(u.id, 'Signed in'); return { token: signToken({ uid: u.id, role: 'admin' }, 12), user: publicUser(u) };
});
route('GET', '/api/admin/stats', 'admin', async () => {
  const cfg = { watch_days: 3, warn_days: 1 }, risk = {};
  (await all('SELECT * FROM items')).map((i) => decorate(i, cfg)).filter((i) => i.level !== 'Advisory').forEach((i) => { risk[i.category] = (risk[i.category] || 0) + 1; });
  const lv = Object.fromEntries(LEVELS.map((l) => [l, 0])); (await all('SELECT level, COUNT(*) n FROM alerts GROUP BY level')).forEach((r) => { lv[r.level] = r.n; });
  const dev = await all('SELECT last_seen FROM devices'), n = async (sql) => (await get(sql)).n;
  return { households: await n('SELECT COUNT(*) n FROM households'), users: await n("SELECT COUNT(*) n FROM users WHERE role='user'"), verified: await n("SELECT COUNT(*) n FROM users WHERE role='user' AND verified=1"), devices: dev.length, online: dev.filter((d) => isOnline(d.last_seen)).length,
    items: await n('SELECT COUNT(*) n FROM items'), discarded: await n("SELECT COUNT(*) n FROM consumption_logs WHERE outcome='discarded'"), consumed: await n("SELECT COUNT(*) n FROM consumption_logs WHERE outcome='consumed'"), alerts: await n('SELECT COUNT(*) n FROM alerts'), atRisk: risk, alertsByLevel: lv };
});
route('GET', '/api/admin/users', 'admin', () => all("SELECT u.id,u.name,u.email,u.active,u.verified,u.created_at,h.name AS household,(SELECT COUNT(*) FROM items i WHERE i.household_id=u.household_id) AS items FROM users u LEFT JOIN households h ON h.id=u.household_id WHERE u.role='user' ORDER BY u.id DESC"));
route('PATCH', '/api/admin/users/:id', 'admin', async (c) => { const u = await get("SELECT * FROM users WHERE id=? AND role='user'", c.params.id); if (!u) throw new HttpError(404, 'User not found.'); await run('UPDATE users SET active=? WHERE id=?', c.body.active ? 1 : 0, u.id); await audit(c.user.id, `${c.body.active ? 'Activated' : 'Suspended'} ${u.email}`); return { ok: true }; });
route('POST', '/api/admin/admins', 'admin', async (c) => {
  const email = clean(c.body.email).toLowerCase(), pw = String(c.body.password || ''); if (!EMAIL.test(email) || pw.length < 10) throw bad('Enter a valid email and a password of at least 10 characters.');
  if (await get('SELECT 1 x FROM users WHERE email=?', email)) throw new HttpError(409, 'That email is already in use.');
  await run("INSERT INTO users (name,email,password_hash,role,verified) VALUES (?,?,?,'admin',1)", clean(c.body.name, 60) || 'Administrator', email, hashPassword(pw)); await audit(c.user.id, `Created admin ${email}`); c.status = 201; return { ok: true };
});
const devRow = (d) => ({ id: d.id, code: d.code, fw: d.fw, household: d.household, householdId: d.household_id, lastSeen: d.last_seen, online: isOnline(d.last_seen), pending: d.command });
route('GET', '/api/admin/devices', 'admin', async () => (await all('SELECT d.*, h.name AS household FROM devices d LEFT JOIN households h ON h.id=d.household_id ORDER BY d.id DESC')).map(devRow));
route('POST', '/api/admin/devices', 'admin', async (c) => {
  const code = clean(c.body.code, 20).toUpperCase() || 'KF-' + randomCode(6), key = randomKey();
  if (await get('SELECT 1 x FROM devices WHERE code=?', code)) throw new HttpError(409, 'Device code already exists.');
  await run('INSERT INTO devices (code, api_key) VALUES (?,?)', code, key); await audit(c.user.id, `Registered device ${code}`); c.status = 201;
  return { code, apiKey: key, note: 'Put this API key in the ESP32 firmware. It is shown only once.' };
});
route('POST', '/api/admin/devices/:id/command', 'admin', async (c) => { if (!['test', 'buzz', 'restart'].includes(c.body.cmd)) throw bad('Unknown command.'); await run('UPDATE devices SET command=? WHERE id=?', c.body.cmd, c.params.id); await audit(c.user.id, `Queued ${c.body.cmd} for device ${c.params.id}`); return { ok: true }; });
route('DELETE', '/api/admin/devices/:id', 'admin', async (c) => { await run('DELETE FROM devices WHERE id=?', c.params.id); await audit(c.user.id, `Removed device ${c.params.id}`); return { ok: true }; });
route('GET', '/api/admin/catalog', 'admin', () => all('SELECT * FROM food_catalog ORDER BY id'));
route('PUT', '/api/admin/catalog/:id', 'admin', async (c) => { const d = Math.max(1, Math.min(365, Math.round(+c.body.shelf_days))); await run('UPDATE food_catalog SET shelf_days=? WHERE id=?', d, c.params.id); await audit(c.user.id, `Set shelf life of catalog ${c.params.id} to ${d} days`); return { ok: true }; });
route('POST', '/api/admin/catalog', 'admin', async (c) => { const cat = clean(c.body.category, 40); if (!cat) throw bad('Enter a category name.'); await run('INSERT INTO food_catalog (category,shelf_days,emoji) VALUES (?,?,?) ON CONFLICT (category) DO NOTHING', cat, Math.max(1, Math.round(+c.body.shelf_days) || 7), clean(c.body.emoji, 4) || '🧺'); await audit(c.user.id, `Added category ${cat}`); c.status = 201; return { ok: true }; });
route('GET', '/api/admin/recipes', 'admin', async () => (await all('SELECT r.*, (SELECT COUNT(*) FROM recipe_ings WHERE recipe_id=r.id) AS ings FROM recipes r ORDER BY id')).map((r) => ({ ...r, steps: JSON.parse(r.steps).length, published: !!r.published })));
route('POST', '/api/admin/recipes', 'admin', async (c) => {
  const b = c.body, name = clean(b.name, 80), steps = (b.steps || []).map((s) => clean(s, 300)).filter(Boolean), ings = (b.ingredients || []).map((g) => ({ key: clean(g.key, 40).toLowerCase(), amount: clean(g.amount, 80) })).filter((g) => g.key);
  if (!name || !steps.length || !ings.length) throw bad('A recipe needs a name, ingredients, and steps.');
  const id = await tx(async () => { const rid = await insert('INSERT INTO recipes (name,emoji,color,time,servings,steps,custom) VALUES (?,?,?,?,?,?,1)', name, clean(b.emoji, 4) || '🍽️', ['#fde3e3', '#fff0c9', '#dff5e3', '#dcedfb', '#fff3cf'][Math.floor(Math.random() * 5)], clean(b.time, 20) || '30 min', Math.max(1, +b.servings || 2), JSON.stringify(steps)); for (const g of ings) await run('INSERT INTO recipe_ings (recipe_id,key,amount) VALUES (?,?,?)', rid, g.key, g.amount || g.key); return rid; });
  await audit(c.user.id, `Added recipe ${name}`); c.status = 201; return { id };
});
route('PATCH', '/api/admin/recipes/:id', 'admin', async (c) => { await run('UPDATE recipes SET published=? WHERE id=?', c.body.published ? 1 : 0, c.params.id); await audit(c.user.id, `${c.body.published ? 'Published' : 'Hid'} recipe ${c.params.id}`); return { ok: true }; });
route('DELETE', '/api/admin/recipes/:id', 'admin', async (c) => { const r = await get('SELECT * FROM recipes WHERE id=? AND custom=1', c.params.id); if (!r) throw bad('Only custom recipes can be deleted. Hide built-in ones instead.'); await run('DELETE FROM recipes WHERE id=?', r.id); await audit(c.user.id, `Deleted recipe ${r.name}`); return { ok: true }; });
route('GET', '/api/admin/announcements', 'admin', () => all('SELECT * FROM announcements ORDER BY id DESC LIMIT 50'));
route('POST', '/api/admin/announcements', 'admin', async (c) => {
  const level = LEVELS.includes(c.body.level) ? c.body.level : 'Advisory', message = clean(c.body.message, 400); if (!message) throw bad('Write a message.');
  const aud = c.body.householdId ? `household:${+c.body.householdId}` : 'all';
  const users = aud === 'all' ? await all("SELECT * FROM users WHERE role='user' AND verified=1 AND active=1") : await all("SELECT * FROM users WHERE role='user' AND verified=1 AND active=1 AND household_id=?", +c.body.householdId);
  await run('INSERT INTO announcements (level,message,audience,created_by) VALUES (?,?,?,?)', level, message, aud, c.user.id);
  for (const u of users) await deliver(u, await settingsOf(u.id), { level, message: `${level}: ${message}`, householdId: u.household_id, kind: 'announcement' });
  await audit(c.user.id, `Sent ${level} advisory to ${aud}`); c.status = 201; return { sentTo: users.length };
});
route('GET', '/api/admin/households', 'admin', () => all('SELECT id, name FROM households ORDER BY name'));
route('GET', '/api/admin/audit', 'admin', () => all('SELECT a.*, u.email FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 60'));
route('GET', '/api/health', null, () => ({ ok: true, service: 'KeepFresh' }));



