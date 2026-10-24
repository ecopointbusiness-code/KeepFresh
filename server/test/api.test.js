// End-to-end API test. Run: node test/api.test.js  (uses an in-memory database)
process.env.DB_FILE = ':memory:';
process.env.KF_TEST = '1';
process.env.ADMIN_EMAIL = 'admin@test.local';

const { seed } = await import('../src/seed.js');
const { createApp } = await import('../src/app.js');
const { log, setTransport } = await import('../src/notify.js');
const { iso, today, addDays } = await import('../src/util.js');
await seed();
const sent = []; const codeOf = () => sent.at(-1).text.match(/\b(\d{6})\b/)[1];
const srv = createApp().listen(0); const base = `http://localhost:${srv.address().port}`;
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : (fail++, console.log('  FAIL', m)); };
async function call(method, path, body, token, hdr = {}) {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...hdr }, body: body ? JSON.stringify(body) : undefined });
  return { s: r.status, d: await r.json().catch(() => ({})) };
}
const t = iso(today());

{ const o = await fetch(base + '/api/items', { method: 'OPTIONS', headers: { Origin: 'capacitor://localhost', 'Access-Control-Request-Method': 'GET' } }); ok(o.status === 204 && o.headers.get('access-control-allow-origin') === 'capacitor://localhost', 'CORS preflight works for the Android app'); const x = await fetch(base + '/api/catalog', { headers: { Origin: 'https://evil.example' } }); ok(!x.headers.get('access-control-allow-origin'), 'unknown origins get no CORS access'); }
// --- sign up requires email verification
let r = await call('POST', '/api/auth/register', { firstName: 'No', lastName: 'Mail', email: 'nomail@test.com', password: 'secret123' });
ok(r.s === 503, 'sign-up refused when email is not configured (no code is ever shown)');
setTransport(async (m) => { sent.push(m); });
r = await call('POST', '/api/auth/register', { firstName: 'Maria', middleName: 'Reyes', lastName: 'Santos', email: 'maria@test.com', password: 'secret123' });
ok(r.s === 201 && r.d.needsVerification, 'register creates unverified user');
ok(!JSON.stringify(r.d).match(/\d{6}/), 'API response never contains the code');
let code = codeOf(); ok(/^\d{6}$/.test(code) && sent.at(-1).to === 'maria@test.com', 'verification code was emailed to the user');
r = await call('POST', '/api/auth/login', { email: 'maria@test.com', password: 'secret123' });
ok(r.s === 403 && r.d.needsVerification, 'login blocked before verification'); code = codeOf(); ok(!JSON.stringify(r.d).match(/\d{6}/), 'login response never contains the code');
r = await call('POST', '/api/auth/verify', { email: 'maria@test.com', code: '000000' });
ok(r.s === 400, 'wrong code rejected');
r = await call('POST', '/api/auth/verify', { email: 'maria@test.com', code });
ok(r.s === 200 && r.d.token, 'correct code verifies and signs in');
const tok = r.d.token;
r = await call('POST', '/api/auth/login', { email: 'maria@test.com', password: 'secret123' });
ok(r.s === 200, 'login works after verification');
r = await call('POST', '/api/auth/register', { firstName: 'X', lastName: 'Y', email: 'maria@test.com', password: 'secret123' });
ok(r.s === 409, 'duplicate verified email rejected');

r = await call('POST', '/api/auth/register', { firstName: 'Only', email: 'o@test.com', password: 'secret123' }); ok(r.s === 400, 'last name is required');
// --- users can never use admin routes
r = await call('GET', '/api/admin/stats', null, tok); ok(r.s === 403, 'user token blocked from admin API');
r = await call('POST', '/api/admin/login', { email: 'maria@test.com', password: 'secret123' }); ok(r.s === 401, 'user cannot log in to admin portal');
r = await call('POST', '/api/auth/login', { email: 'admin@test.local', password: 'Keepfresh@2026' }); ok(r.s === 401, 'admin cannot use user login');

// --- inventory + prediction + alerts
r = await call('POST', '/api/items', { name: 'Chicken breast', category: 'Poultry', qty: '1 kg', bought: addDays(t, -2) }, tok);
ok(r.s === 201 && r.d.predicted && r.d.daysLeft === 0 && r.d.level === 'Warning', 'meat without date gets predicted expiry (2 days) and Warning');
r = await call('POST', '/api/items', { name: 'Ground pork', category: 'Ground meat', bought: addDays(t, -5) }, tok);
ok(r.d.level === 'Critical', 'old meat is Critical');
await call('POST', '/api/items', { name: 'Milk', category: 'Dairy', bought: t, expires: addDays(t, 10) }, tok);
r = await call('GET', '/api/alerts', null, tok);
ok(r.d.alerts.length >= 2 && r.d.unread >= 2, 'alerts created');
ok(log.some((l) => l.channel === 'push'), 'push attempted');
ok(log.filter((l) => l.channel === 'email' && l.subject.includes('Critical')).length >= 1, 'critical alert emailed');
r = await call('GET', '/api/items', null, tok); ok(r.d.length === 3 && r.d[0].level === 'Critical', 'items listed most urgent first');
// learning from history
const pork = r.d.find((i) => i.name === 'Ground pork');
await call('DELETE', `/api/items/${pork.id}?outcome=discarded`, null, tok);
r = await call('POST', '/api/predict', { category: 'Ground meat', bought: t }, tok);
ok(r.d.samples === 1 && r.d.confidence > 0.5, 'prediction learns from household history');

// --- recipes and grocery
r = await call('GET', '/api/recipes', null, tok);
ok(r.d[0].name.includes('Adobo') || r.d[0].name.includes('Tinola'), 'chicken recipes ranked first (uses expiring chicken)');
const adobo = r.d.find((x) => x.name === 'Chicken Adobo'); ok(adobo.steps.length === 5 && adobo.ingredients.length === 7, 'recipe has steps and amounts');
r = await call('POST', '/api/grocery/add-missing', { recipeId: adobo.id }, tok);
r = await call('GET', '/api/grocery', null, tok);
ok(r.d.list.some((g) => g.name === 'soy sauce'), 'missing adobo ingredients added to grocery list');
const gid = r.d.list[0].id;
await call('PATCH', `/api/grocery/${gid}`, { done: true }, tok);
r = await call('POST', '/api/grocery/move-bought', null, tok); ok(r.d.moved === 1, 'bought item moved to fridge');
r = await call('POST', `/api/recipes/${adobo.id}/cook`, null, tok); ok(r.d.used === 1, 'cooking marks fresh chicken as used');

// --- settings
r = await call('PUT', '/api/settings', { watch_days: 5, warn_days: 2, email_on: false }, tok); ok(r.d.watch_days === 5 && r.d.email_on === 0, 'settings saved');

// --- device
r = await call('POST', '/api/admin/login', { email: 'admin@test.local', password: 'Keepfresh@2026' }); ok(r.s === 200, 'admin login');
const at = r.d.token;
r = await call('POST', '/api/admin/devices', {}, at); ok(r.s === 201 && r.d.apiKey, 'admin registers device');
const dev = r.d;
r = await call('POST', '/api/household/device', { code: dev.code }, tok); ok(r.s === 200, 'user links device by code');
r = await call('GET', '/api/device/status', null, null, { 'x-device-key': dev.apiKey }); ok(r.s === 200 && ['green', 'yellow', 'red'].includes(r.d.led), 'device gets status');
ok(r.d.counts && typeof r.d.total === 'number' && Array.isArray(r.d.items) && 'tip' in r.d && 'advisory' in r.d, 'device status has screen details');
r = await call('GET', '/api/device/status', null, null, { 'x-device-key': 'nope' }); ok(r.s === 401, 'bad device key rejected');
const list = await call('GET', '/api/admin/devices', null, at); await call('POST', `/api/admin/devices/${list.d[0].id}/command`, { cmd: 'test' }, at);
r = await call('GET', '/api/device/status', null, null, { 'x-device-key': dev.apiKey }); ok(r.d.command === 'test', 'device receives queued command');

// --- admin
r = await call('GET', '/api/admin/stats', null, at); ok(r.s === 200 && r.d.users === 1 && r.d.verified === 1, 'admin stats');
r = await call('GET', '/api/admin/users', null, at); const uid = r.d[0].id;
r = await call('POST', '/api/admin/announcements', { level: 'Watch', message: 'Store raw chicken on the lowest shelf.' }, at); ok(r.d.sentTo === 1, 'advisory delivered to users');
r = await call('GET', '/api/alerts', null, tok); ok(r.d.alerts[0].kind === 'announcement', 'user sees advisory');
r = await call('POST', '/api/admin/recipes', { name: 'Test Dish', ingredients: [{ key: 'egg', amount: '2 eggs' }], steps: ['Cook it'] }, at); ok(r.s === 201, 'admin adds recipe');
r = await call('PATCH', `/api/admin/users/${uid}`, { active: false }, at); ok(r.s === 200, 'admin suspends user');
r = await call('GET', '/api/items', null, tok); ok(r.s === 401, 'suspended user is locked out');
r = await call('POST', '/api/auth/forgot', { email: 'maria@test.com' }); ok(r.s === 200, 'forgot endpoint is generic');

// --- password reset
await call('PATCH', `/api/admin/users/${uid}`, { active: true }, at);
r = await call('POST', '/api/auth/forgot', { email: 'maria@test.com' }); const rc = codeOf(); ok(/^\d{6}$/.test(rc) && !r.d.devCode, 'reset code emailed only');
r = await call('POST', '/api/auth/reset', { email: 'maria@test.com', code: rc, password: 'newsecret99' }); ok(r.s === 200, 'password reset');
r = await call('POST', '/api/auth/login', { email: 'maria@test.com', password: 'newsecret99' }); ok(r.s === 200, 'login with new password');

console.log(`\n${pass} passed, ${fail} failed`); srv.close(); process.exit(fail ? 1 : 0);
