import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export class HttpError extends Error { constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; } }
export const bad = (m = 'Bad request') => new HttpError(400, m);

function loadSecret() {
  if (process.env.JWT_SECRET && process.env.JWT_SECRET !== 'change-me-to-a-long-random-string') return process.env.JWT_SECRET;
  const f = path.join(path.dirname(process.env.DB_FILE || './data/x'), '.secret');
  try { return fs.readFileSync(f, 'utf8'); } catch {}
  const s = crypto.randomBytes(48).toString('hex');
  try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s, { mode: 0o600 }); } catch {}
  return s;
}
const SECRET = loadSecret();

const b64 = (b) => Buffer.from(b).toString('base64url');
export function signToken(payload, hours = 24 * 14) {
  const head = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + hours * 3600 }));
  const sig = crypto.createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}
export function verifyToken(t) {
  try {
    const [h, b, s] = t.split('.');
    const sig = crypto.createHmac('sha256', SECRET).update(`${h}.${b}`).digest('base64url');
    if (s.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(sig))) return null;
    const p = JSON.parse(Buffer.from(b, 'base64url').toString());
    return p.exp > Date.now() / 1000 ? p : null;
  } catch { return null; }
}

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}
export function checkPassword(pw, stored) {
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(pw, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(test));
}
export const randomCode = (n = 6) => crypto.randomBytes(n).toString('hex').slice(0, n).toUpperCase();
export const randomKey = () => crypto.randomBytes(24).toString('hex');

export const today = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
export const iso = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
export const addDays = (s, n) => { const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + n); return iso(d); };
export const daysLeft = (exp) => Math.round((new Date(exp + 'T00:00:00') - today()) / 864e5);
export const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 864e5);

const routes = [];
export function route(method, p, auth, handler) {
  const keys = [];
  const re = new RegExp('^' + p.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
  routes.push({ method, re, keys, auth, handler });
}
export function match(method, pathname) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = r.re.exec(pathname);
    if (m) return { r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
  }
  return null;
}

const hits = new Map();
export function limit(key, max = 10, windowMs = 15 * 60 * 1000) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  arr.push(now); hits.set(key, arr);
  if (arr.length > max) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
}
