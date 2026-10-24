import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { get } from './db.js';
import { match, verifyToken, HttpError } from './util.js';
import './routes.js';

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../client/dist');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const SEC = { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'" };

const ORIGINS = new Set(['capacitor://localhost', 'https://localhost', 'http://localhost', ...(process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean)]);
function cors(req, res) {
  const o = req.headers.origin;
  if (!o || !ORIGINS.has(o)) return;
  res.setHeader('Access-Control-Allow-Origin', o); res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization'); res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
}

function send(res, status, data, headers = {}) {
  const body = JSON.stringify(data ?? {});
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SEC, ...headers });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 200_000) { reject(new HttpError(413, 'Request too large.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { if (!chunks.length) return resolve({}); try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch { reject(new HttpError(400, 'Invalid JSON.')); } });
    req.on('error', reject);
  });
}
async function authenticate(req, kind) {
  if (kind === 'device') {
    const key = req.headers['x-device-key']; const d = key && await get('SELECT * FROM devices WHERE api_key=?', String(key));
    if (!d) throw new HttpError(401, 'Unknown device.'); return { device: d };
  }
  const h = req.headers.authorization || ''; const p = h.startsWith('Bearer ') ? verifyToken(h.slice(7)) : null;
  if (!p) throw new HttpError(401, 'Please sign in.');
  if (p.role !== kind) throw new HttpError(403, 'Not allowed.');          // users can never reach admin routes
  const user = await get('SELECT * FROM users WHERE id=?', p.uid);
  if (!user || !user.active || user.role !== kind || (kind === 'user' && !user.verified)) throw new HttpError(401, 'Please sign in again.');
  return { user };
}

async function api(req, res, url) {
  const m = match(req.method, url.pathname);
  if (!m) return send(res, 404, { error: 'Not found.' });
  try {
    const ctx = { req, ip: req.socket.remoteAddress || '', query: url.searchParams, params: m.params, status: 200, body: {} };
    if (m.r.auth) Object.assign(ctx, await authenticate(req, m.r.auth));
    if (['POST', 'PUT', 'PATCH'].includes(req.method)) ctx.body = await readBody(req);
    const data = await m.r.handler(ctx);
    send(res, ctx.status, data);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message, ...e.extra });
    console.error(e); send(res, 500, { error: 'Something went wrong.' });
  }
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/admin' || rel === '/admin/') rel = '/admin.html';
  let file = path.join(DIST, rel);
  if (!file.startsWith(DIST)) { res.writeHead(403); return res.end(); }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, rel.startsWith('/admin') ? 'admin.html' : 'index.html');
  if (!fs.existsSync(file)) { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('KeepFresh API is running. Build the client: npm run build --prefix client'); }
  const ext = path.extname(file);
  const cache = file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache';
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cache, ...SEC });
  fs.createReadStream(file).pipe(res);
}

export function createApp() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) { cors(req, res); if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); } return api(req, res, url); }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    serveStatic(req, res, url);
  });
}
