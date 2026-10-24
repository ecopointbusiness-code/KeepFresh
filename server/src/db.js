import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';

/**
 * One tiny async database layer with two drivers:
 *  - PostgreSQL (Supabase)  when DATABASE_URL is set   <- use this for the real system
 *  - SQLite file            when DATABASE_URL is empty <- zero-setup development and tests
 * All SQL in the app is written to run on both, using ? placeholders.
 */
export const isPg = !!process.env.DATABASE_URL;
export const isFirebase = (process.env.DATABASE_PROVIDER || '').toLowerCase() === 'firebase';
const als = new AsyncLocalStorage();

const TABLES = ['households', 'users', 'email_codes', 'food_catalog', 'items', 'consumption_logs', 'alerts', 'alert_state', 'settings', 'push_subs', 'recipes', 'recipe_ings', 'grocery', 'devices', 'device_logs', 'announcements', 'audit_logs'];
const DDL = `
CREATE TABLE IF NOT EXISTS households (id {PK}, name TEXT NOT NULL, invite_code TEXT UNIQUE NOT NULL, created_at TEXT DEFAULT {NOW});
CREATE TABLE IF NOT EXISTS users (id {PK}, name TEXT NOT NULL, first_name TEXT, last_name TEXT, middle_name TEXT, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', verified INTEGER NOT NULL DEFAULT 0, household_id INTEGER REFERENCES households(id), active INTEGER NOT NULL DEFAULT 1, created_at TEXT DEFAULT {NOW});
CREATE TABLE IF NOT EXISTS email_codes (id {PK}, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, purpose TEXT NOT NULL, code_hash TEXT NOT NULL, expires BIGINT NOT NULL, attempts INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS food_catalog (id {PK}, category TEXT UNIQUE NOT NULL, shelf_days INTEGER NOT NULL, emoji TEXT DEFAULT '🧺');
CREATE TABLE IF NOT EXISTS items (id {PK}, household_id INTEGER NOT NULL REFERENCES households(id), name TEXT NOT NULL, category TEXT NOT NULL, qty TEXT DEFAULT '1', bought TEXT NOT NULL, expires TEXT NOT NULL, predicted INTEGER DEFAULT 0, confidence REAL, prediction_source TEXT DEFAULT 'reference', added_by INTEGER, created_at TEXT DEFAULT {NOW});
CREATE TABLE IF NOT EXISTS consumption_logs (id {PK}, household_id INTEGER NOT NULL, category TEXT NOT NULL, days INTEGER NOT NULL, outcome TEXT NOT NULL, created_at TEXT DEFAULT {NOW});
CREATE TABLE IF NOT EXISTS alerts (id {PK}, user_id INTEGER NOT NULL, household_id INTEGER, item_id INTEGER, kind TEXT DEFAULT 'item', level TEXT NOT NULL, message TEXT NOT NULL, channels TEXT DEFAULT '', acked INTEGER DEFAULT 0, created_at TEXT DEFAULT {NOW});
CREATE TABLE IF NOT EXISTS alert_state (user_id INTEGER NOT NULL, item_id INTEGER NOT NULL, level TEXT NOT NULL, PRIMARY KEY (user_id, item_id));
CREATE TABLE IF NOT EXISTS settings (user_id INTEGER PRIMARY KEY, watch_days INTEGER DEFAULT 3, warn_days INTEGER DEFAULT 1, email_on INTEGER DEFAULT 1, push_on INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS push_subs (id {PK}, user_id INTEGER NOT NULL, endpoint TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS recipes (id {PK}, name TEXT NOT NULL, emoji TEXT DEFAULT '🍽️', color TEXT DEFAULT '#fff0c9', time TEXT, servings INTEGER DEFAULT 4, steps TEXT NOT NULL, published INTEGER DEFAULT 1, custom INTEGER DEFAULT 0, ai_generated INTEGER NOT NULL DEFAULT 0, household_id INTEGER);
CREATE TABLE IF NOT EXISTS recipe_ings (id {PK}, recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE, key TEXT NOT NULL, amount TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS grocery (id {PK}, household_id INTEGER NOT NULL, name TEXT NOT NULL, qty TEXT DEFAULT '', why TEXT DEFAULT '', done INTEGER DEFAULT 0, created_at TEXT DEFAULT {NOW});
CREATE TABLE IF NOT EXISTS devices (id {PK}, code TEXT UNIQUE NOT NULL, api_key TEXT UNIQUE NOT NULL, household_id INTEGER, fw TEXT DEFAULT '1.0.0', last_seen TEXT, command TEXT, created_at TEXT DEFAULT {NOW});
CREATE TABLE IF NOT EXISTS device_logs (id {PK}, device_id INTEGER NOT NULL, led TEXT NOT NULL, message TEXT, created_at TEXT DEFAULT {NOW});
CREATE TABLE IF NOT EXISTS announcements (id {PK}, level TEXT NOT NULL, message TEXT NOT NULL, audience TEXT NOT NULL, created_by INTEGER, created_at TEXT DEFAULT {NOW});
CREATE TABLE IF NOT EXISTS audit_logs (id {PK}, user_id INTEGER, action TEXT NOT NULL, created_at TEXT DEFAULT {NOW});
CREATE INDEX IF NOT EXISTS idx_items_h ON items(household_id);
CREATE INDEX IF NOT EXISTS idx_alerts_u ON alerts(user_id);
`;

let impl;
if (isFirebase) {
  impl = await import('./firestore-db.js');
} else if (isPg) {
  let pg;
  try { pg = (await import('pg')).default; } catch { throw new Error('DATABASE_URL is set but the "pg" package is missing. Run: npm install --prefix server'); }
  pg.types.setTypeParser(20, (v) => parseInt(v, 10)); // COUNT(*) and BIGINT come back as numbers
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 8, ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false } });
  pool.on('error', (e) => console.warn('[db]', e.message));
  const toPg = (sql) => { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); };
  const q = (sql, p) => (als.getStore() || pool).query(toPg(sql), p);
  impl = {
    all: async (s, p) => (await q(s, p)).rows,
    get: async (s, p) => (await q(s, p)).rows[0],
    run: async (s, p) => { const r = await q(s, p); return { changes: r.rowCount, id: r.rows[0]?.id }; },
    tx: async (fn) => {
      const c = await pool.connect();
      try { await c.query('BEGIN'); const r = await als.run(c, fn); await c.query('COMMIT'); return r; }
      catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
    },
    init: async () => {
      await pool.query(DDL.replaceAll('{PK}', 'SERIAL PRIMARY KEY').replaceAll('{NOW}', `(to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS"Z"'))`));
      await pool.query("ALTER TABLE items ADD COLUMN IF NOT EXISTS prediction_source TEXT DEFAULT 'reference'");
      await pool.query('ALTER TABLE recipes ADD COLUMN IF NOT EXISTS ai_generated INTEGER NOT NULL DEFAULT 0');
      await pool.query('ALTER TABLE recipes ADD COLUMN IF NOT EXISTS household_id INTEGER');
      // Supabase exposes the public schema over its REST API. Lock every table so only this server (the database owner) can use them.
      for (const t of TABLES) await pool.query(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
    },
  };
} else {
  const { DatabaseSync } = await import('node:sqlite');
  const file = process.env.DB_FILE || './data/keepfresh.db';
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  let lock = Promise.resolve();
  impl = {
    all: async (s, p = []) => db.prepare(s).all(...p).map((r) => ({ ...r })),
    get: async (s, p = []) => { const r = db.prepare(s).get(...p); return r ? { ...r } : undefined; },
    run: async (s, p = []) => {
      if (/\bRETURNING\b/i.test(s)) { const rows = db.prepare(s).all(...p); return { changes: rows.length, id: rows[0]?.id }; }
      const r = db.prepare(s).run(...p); return { changes: Number(r.changes), id: undefined };
    },
    tx: (fn) => { const next = lock.then(async () => { db.exec('BEGIN'); try { const r = await fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } }); lock = next.catch(() => {}); return next; },
    init: async () => {
      db.exec(DDL.replaceAll('{PK}', 'INTEGER PRIMARY KEY').replaceAll('{NOW}', `(strftime('%Y-%m-%dT%H:%M:%SZ','now'))`));
      const ensureColumn = (table, column, definition) => {
        const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
        if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      };
      for (const c of ['first_name', 'last_name', 'middle_name']) ensureColumn('users', c, 'TEXT');
      ensureColumn('items', 'prediction_source', "TEXT DEFAULT 'reference'");
      ensureColumn('recipes', 'ai_generated', 'INTEGER NOT NULL DEFAULT 0');
      ensureColumn('recipes', 'household_id', 'INTEGER');
    },
  };
}

await impl.init();
export const all = (sql, ...p) => impl.all(sql, p);
export const get = (sql, ...p) => impl.get(sql, p);
export const run = (sql, ...p) => impl.run(sql, p);
/** INSERT that returns the new row id (works on both databases). */
export const insert = async (sql, ...p) => (await impl.run(sql + ' RETURNING id', p)).id;
export const tx = (fn) => impl.tx(fn);
export const dbKind = isFirebase ? 'Firebase Cloud Firestore' : isPg ? 'Supabase (PostgreSQL)' : 'SQLite file';



