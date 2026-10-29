import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import alasql from 'alasql';
import { applicationDefault, cert, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const TABLES = ['households', 'users', 'email_codes', 'food_catalog', 'items', 'consumption_logs', 'alerts', 'alert_state', 'settings', 'push_subs', 'recipes', 'recipe_ings', 'grocery', 'devices', 'device_logs', 'announcements', 'audit_logs'];
const als = new AsyncLocalStorage();
const projectId = process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT;
let credential;
if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  credential = cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON));
} else if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
  credential = cert(JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8')));
} else if (process.env.FIREBASE_SERVICE_ACCOUNT_FILE) {
  const keyFile = path.resolve(process.cwd(), process.env.FIREBASE_SERVICE_ACCOUNT_FILE);
  credential = cert(JSON.parse(fs.readFileSync(keyFile, 'utf8')));
} else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  credential = applicationDefault();
} else {
  throw new Error('Firestore selected but no service account is configured. Set GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_SERVICE_ACCOUNT_JSON on the server.');
}
const app = getApps().find((x) => x.name === 'keepfresh') || initializeApp({ credential, ...(projectId ? { projectId } : {}) }, 'keepfresh');
const firestore = getFirestore(app);
const collection = (name) => firestore.collection(`keepfresh_${name}`);
let queue = Promise.resolve();
const serialize = (fn) => { const next = queue.then(fn); queue = next.catch(() => {}); return next; };
// SQL compatibility queries currently load collections into memory. Reuse
// those snapshots briefly so frequent dashboard/device requests do not each
// bill a fresh read of every document. Writes invalidate the affected table.
const ROW_CACHE_MS = 15000;
const rowCache = new Map();

const splitCsv = (s) => {
  const out = []; let start = 0, depth = 0, quote = '';
  for (let i = 0; i < s.length; i++) { const c = s[i]; if (quote) { if (c === quote && s[i + 1] === quote) i++; else if (c === quote) quote = ''; } else if (c === "'" || c === '"') quote = c; else if (c === '(') depth++; else if (c === ')') depth--; else if (c === ',' && depth === 0) { out.push(s.slice(start, i).trim()); start = i + 1; } }
  out.push(s.slice(start).trim()); return out;
};

function tablesIn(sql) {
  const names = new Set();
  for (const match of sql.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE|DELETE\s+FROM)\s+([a-z_][a-z0-9_]*)/gi)) if (TABLES.includes(match[1].toLowerCase())) names.add(match[1].toLowerCase());
  return [...names];
}

async function fetchRows(table) {
  const cached = rowCache.get(table);
  if (cached && Date.now() - cached.loadedAt < ROW_CACHE_MS) return cached.rows.map((row) => ({ ...row }));
  const snap = await collection(table).get();
  const rows = snap.docs.map((d) => ({ ...d.data(), id: Number(d.id) }));
  rowCache.set(table, { loadedAt: Date.now(), rows });
  return rows.map((row) => ({ ...row }));
}

async function ensureRows(ctx, names) {
  for (const table of names) if (!ctx.rows.has(table)) {
    const rows = await fetchRows(table);
    ctx.rows.set(table, rows); ctx.original.set(table, rows.map((x) => ({ ...x })));
  }
}

function makeEngine(rows) {
  const db = new alasql.Database();
  for (const [table, data] of rows) { db.exec(`CREATE TABLE ${table}`); db.tables[table].data = data.map((x) => ({ ...x })); }
  return db;
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

async function commit(ctx) {
  const writes = [];
  for (const [table, rows] of ctx.rows) {
    if (!ctx.changed.has(table)) continue;
    const old = new Map(ctx.original.get(table).map((r) => [String(r.id), r]));
    const now = new Map(rows.map((r) => [String(r.id), r]));
    for (const [id, row] of now) if (!old.has(id) || stable(old.get(id)) !== stable(row)) writes.push({ type: 'set', table, id, row });
    for (const id of old.keys()) if (!now.has(id)) writes.push({ type: 'delete', table, id });
  }
  for (const [table, value] of ctx.nextIds) writes.push({ type: 'counter', table, value });
  if (writes.length > 4500) throw new Error(`Firestore batch too large (${writes.length} writes); split this operation into smaller batches.`);
  for (let i = 0; i < writes.length; i += 450) {
    const batch = firestore.batch();
    for (const w of writes.slice(i, i + 450)) {
      if (w.type === 'counter') {
        batch.set(firestore.collection('_keepfresh_meta').doc(`counter_${w.table}`), { value: w.value });
        continue;
      }
      const ref = collection(w.table).doc(w.id);
      if (w.type === 'delete') batch.delete(ref); else batch.set(ref, cleanRow(w.row));
    }
    await batch.commit();
  }
  for (const table of ctx.changed) rowCache.delete(table);
}

function cleanRow(row) { return Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined)); }

async function nextId(table, ctx) {
  const ref = firestore.collection('_keepfresh_meta').doc(`counter_${table}`);
  if (!ctx.nextIds.has(table)) {
    const snapshot = await ref.get();
    const stored = snapshot.exists ? Number(snapshot.get('value')) || 0 : 0;
    const highestRowId = Math.max(0, ...ctx.rows.get(table).map((r) => Number(r.id) || 0));
    ctx.nextIds.set(table, Math.max(stored, highestRowId));
  }
  const id = ctx.nextIds.get(table) + 1;
  ctx.nextIds.set(table, id);
  return id;
}

const DEFAULTS = {
  households: { created_at: () => new Date().toISOString() },
  users: { verified: 0, active: 1, created_at: () => new Date().toISOString() },
  email_codes: { attempts: 0 }, food_catalog: { emoji: '🧺' },
  items: { qty: '1', predicted: 0, prediction_source: 'reference', created_at: () => new Date().toISOString() },
  alerts: { kind: 'item', channels: '', acked: 0, created_at: () => new Date().toISOString() },
  alert_state: {}, settings: { watch_days: 3, warn_days: 1, email_on: 1, push_on: 1 },
  recipes: { emoji: '🍽️', color: '#fff0c9', servings: 4, published: 1, custom: 0, ai_generated: 0 },
  grocery: { qty: '', why: '', done: 0, created_at: () => new Date().toISOString() },
  devices: { fw: '1.0.0', created_at: () => new Date().toISOString() },
  device_logs: { created_at: () => new Date().toISOString() },
  announcements: { created_at: () => new Date().toISOString() }, audit_logs: { created_at: () => new Date().toISOString() },
};

function parseValue(expression, params, state) {
  const value = expression.trim();
  if (value === '?') return params[state.i++];
  if (/^NULL$/i.test(value)) return null;
  if (/^\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if (/^'(?:[^']|'')*'$/.test(value)) return value.slice(1, -1).replaceAll("''", "'");
  throw new Error(`Unsupported Firestore insert value: ${value}`);
}

async function insertSql(sql, params, ctx) {
  const m = sql.match(/^INSERT\s+INTO\s+([a-z_][a-z0-9_]*)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)([\s\S]*)$/i);
  if (!m) throw new Error(`Unsupported Firestore insert query: ${sql}`);
  const table = m[1].toLowerCase(), cols = splitCsv(m[2]).map((x) => x.trim()), exps = splitCsv(m[3]);
  const state = { i: 0 }, row = {};
  for (let i = 0; i < cols.length; i++) row[cols[i]] = parseValue(exps[i], params, state);
  for (const [key, value] of Object.entries(DEFAULTS[table] || {})) if (!(key in row)) row[key] = typeof value === 'function' ? value() : value;
  await ensureRows(ctx, [table]);
  row.id = await nextId(table, ctx);

  const conflict = m[4].match(/ON\s+CONFLICT\s*\(([^)]+)\)\s+DO\s+(NOTHING|UPDATE\s+SET\s+([\s\S]+))$/i);
  if (conflict) {
    const fields = splitCsv(conflict[1]).map((x) => x.trim());
    const exists = ctx.rows.get(table).find((r) => fields.every((f) => r[f] === row[f]));
    if (exists) {
      if (/^NOTHING/i.test(conflict[2])) return { changes: 0, id: undefined };
      const assignments = splitCsv(conflict[3]);
      for (const item of assignments) {
        const a = item.match(/^([a-z_][a-z0-9_]*)\s*=\s*excluded\.([a-z_][a-z0-9_]*)$/i);
        if (a) exists[a[1]] = row[a[2]];
      }
      ctx.changed.add(table); return { changes: 1, id: exists.id };
    }
  }
  const uniqueSets = { users: ['email'], households: ['invite_code'], food_catalog: ['category'], devices: ['code', 'api_key'], push_subs: ['endpoint'] }[table] || [];
  for (const key of uniqueSets) if (row[key] != null && ctx.rows.get(table).some((r) => r[key] === row[key])) throw new Error(`Firestore unique constraint: ${table}.${key} already exists.`);
  ctx.rows.get(table).push(row); ctx.changed.add(table); return { changes: 1, id: row.id };
}

async function runInContext(sql, params, ctx) {
  const cleanSql = sql.replace(/\s+RETURNING\s+id\s*$/i, '').trim();
  if (/^INSERT\s+INTO/i.test(cleanSql)) return insertSql(cleanSql, params, ctx);
  const names = tablesIn(cleanSql); await ensureRows(ctx, names);
  const db = makeEngine(ctx.rows);
  const before = new Map(names.map((t) => [t, (ctx.rows.get(t) || []).map((r) => ({ ...r }))]));
  db.exec(cleanSql, params);
  let changes = 0;
  for (const table of names) {
    const updated = db.tables[table]?.data || [];
    if (stable(before.get(table) || []) !== stable(updated)) { ctx.rows.set(table, updated); ctx.changed.add(table); changes++; }
  }
  // SQLite cascades recipe ingredient rows; keep that behavior in Firestore.
  if (/^DELETE\s+FROM\s+recipes\b/i.test(cleanSql) && ctx.changed.has('recipes')) {
    await ensureRows(ctx, ['recipe_ings']);
    const ids = new Set((before.get('recipes') || []).filter((r) => !ctx.rows.get('recipes').some((x) => x.id === r.id)).map((r) => r.id));
    ctx.rows.set('recipe_ings', ctx.rows.get('recipe_ings').filter((r) => !ids.has(r.recipe_id)));
    if (ids.size) ctx.changed.add('recipe_ings');
  }
  return { changes };
}

async function withContext(sql, callback) {
  const active = als.getStore();
  if (active) { await ensureRows(active, tablesIn(sql)); return callback(active); }
  return serialize(async () => {
    const ctx = { rows: new Map(), original: new Map(), changed: new Set(), nextIds: new Map() };
    await ensureRows(ctx, tablesIn(sql));
    const result = await callback(ctx);
    await commit(ctx); return result;
  });
}

export async function all(sql, params = []) {
  return withContext(sql, async (ctx) => {
    const names = tablesIn(sql); await ensureRows(ctx, names);
    const db = makeEngine(ctx.rows);
    return db.exec(sql.trim().replace(/;$/, ''), params);
  });
}
export async function get(sql, params = []) { return (await all(sql, params))[0]; }
export async function run(sql, params = []) { return withContext(sql, (ctx) => runInContext(sql, params, ctx)); }
export async function tx(fn) {
  if (als.getStore()) return fn();
  return serialize(async () => {
    const ctx = { rows: new Map(), original: new Map(), changed: new Set(), nextIds: new Map() };
    const result = await als.run(ctx, fn); await commit(ctx); return result;
  });
}
export const dbKind = 'Firebase Cloud Firestore';
export async function init() {
  // Do not call Firestore during process startup. A quota outage must not stop
  // Render from serving the static app or restarting the API process.
  console.log(`  Firestore project: ${projectId || app.options.projectId || 'application-default'}`);
}
