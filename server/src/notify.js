import { all, run } from './db.js';

let webpush = null, transport = null, warned = false;
async function init() {
  if (init.done) return; init.done = true;
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    try {
      webpush = (await import('web-push')).default;
      webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@keepfresh.local', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
    } catch { console.warn('[notify] web-push is not installed. Run: npm install --prefix server'); }
  }
}
const E = () => Object.fromEntries(Object.entries(process.env).map(([k, v]) => [k, typeof v === 'string' ? v.trim().replace(/^["']|["']$/g, '') : v]));
const templateIdFor = (type, env = E()) => ({
  verification: env.EMAILJS_VERIFICATION_TEMPLATE_ID,
  password_reset: env.EMAILJS_RESET_TEMPLATE_ID,
  warning: env.EMAILJS_WARNING_TEMPLATE_ID,
  announcement: env.EMAILJS_ANNOUNCEMENT_TEMPLATE_ID,
}[type] || env.EMAILJS_TEMPLATE_ID);
const emailjsReady = (type = 'verification') => {
  const env = E();
  return !!(env.EMAILJS_SERVICE_ID && templateIdFor(type, env) && env.EMAILJS_PUBLIC_KEY && env.EMAILJS_PRIVATE_KEY);
};
export const pushEnabled = () => !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
export const mailEnabled = (type = 'verification') => !!(transport || emailjsReady(type));
export const setTransport = (fn) => { transport = fn; };      // used by the automated tests
export const log = [];                                          // only filled when KF_TEST=1

// EmailJS allows about 1 request per second on the free plan, so emails are sent one at a time.
let chain = Promise.resolve();
const queued = (fn) => { const p = chain.then(fn); chain = p.catch(() => {}).then(() => new Promise((r) => setTimeout(r, Number(E().EMAIL_GAP_MS ?? 1100)))); return p; };

/** Emails go ONLY to the user's inbox through EmailJS. Nothing is ever returned to the browser. */
export async function sendEmail(user, subject, text, { type = 'general', ...customParams } = {}) {
  await init();
  const mail = { to: user.email, subject, text };
  if (process.env.KF_TEST) log.unshift({ channel: 'email', ...mail });
  if (transport) { try { await transport(mail); return true; } catch { return false; } }
  if (!emailjsReady(type)) { if (!warned) { warned = true; console.warn(`[email] EmailJS is not configured for ${type} email. Set its EMAILJS_* template ID and server credentials in server/.env`); } return false; }
  const name = user.first_name || user.name?.split(/\s+/)[0] || 'there';
  const templateParams = {
    to_email: user.email, to_name: name, name, first_name: name, user_name: name,
    subject, message: text, email_type: type,
    ...(type === 'verification' || type === 'password_reset' ? {
      code: customParams.code || '', otp: customParams.code || '', otp_code: customParams.code || '',
      verification_code: customParams.code || '', reset_code: customParams.code || '',
      expires_minutes: 15, validity_minutes: 15,
    } : {}),
    ...(type === 'warning' || type === 'announcement' ? {
      alert_message: text, warning_message: text, announcement_message: text,
    } : {}),
    ...customParams,
  };
  return queued(async () => {
    const r = await postEmailJS({ template_id: templateIdFor(type), ...templateParams });
    if (!r.ok) console.warn(`[email] ${r.error}`);
    return r.ok;
  });
}

const HINTS = {
  400: 'Check that the Service ID, Template ID and Public Key are correct and belong to the same EmailJS account. Also check the template "To Email" field is {{to_email}}.',
  401: 'The Public Key or Private Key is wrong. Copy both again from EmailJS > Account.',
  403: 'Turn ON "Allow EmailJS API for non-browser applications" in EmailJS > Account > Security.',
  404: 'The Service ID or Template ID was not found. Check them in the EmailJS dashboard.',
  412: 'The email service (for example Gmail) lost its connection. Open EmailJS > Email Services and reconnect it.',
  422: 'The template rejected the data. Make sure the template Subject is {{subject}} and To Email is {{to_email}}.',
  429: 'EmailJS rate limit reached. Wait a moment and try again.',
};

/** One call to the EmailJS REST API. Returns { ok, error } and never throws. */
export async function postEmailJS(params) {
  const env = E();
  const base = (env.PUBLIC_URL || '').replace(/\/+$/, '');
  const { template_id, ...templateParams } = params;
  try {
    const r = await fetch(env.EMAILJS_URL || 'https://api.emailjs.com/api/v1.0/email/send', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service_id: env.EMAILJS_SERVICE_ID, template_id: template_id || env.EMAILJS_TEMPLATE_ID, user_id: env.EMAILJS_PUBLIC_KEY, accessToken: env.EMAILJS_PRIVATE_KEY,
        template_params: { app_name: 'KeepFresh', logo_url: base ? `${base}/logo.png` : '', ...templateParams } }),
    });
    if (r.ok) return { ok: true };
    const body = (await r.text()).slice(0, 200);
    return { ok: false, error: `EmailJS error ${r.status}: ${body}${HINTS[r.status] ? `\n        Fix: ${HINTS[r.status]}` : ''}` };
  } catch (e) { return { ok: false, error: `Could not reach EmailJS (${e.cause?.code || e.message}). Check the internet connection of the server.` }; }
}
export async function sendPush(user, title, body) {
  await init();
  if (process.env.KF_TEST) log.unshift({ channel: 'push', to: user.email, title, body });
  if (!webpush) return false;
  let ok = false;
  for (const s of await all('SELECT * FROM push_subs WHERE user_id=?', user.id)) {
    try { await webpush.sendNotification(JSON.parse(s.data), JSON.stringify({ title, body, url: '/' })); ok = true; }
    catch (e) { if (e.statusCode === 404 || e.statusCode === 410) await run('DELETE FROM push_subs WHERE id=?', s.id); }
  }
  return ok;
}

/** Create the in-app alert and deliver by the channels the user turned on. */
export async function deliver(user, cfg, { level, message, householdId = null, itemId = null, kind = 'item' }) {
  const channels = ['app'];
  if (cfg.email_on) channels.push('email');
  if (cfg.push_on) channels.push('push');
  await run('INSERT INTO alerts (user_id, household_id, item_id, kind, level, message, channels) VALUES (?,?,?,?,?,?,?)', user.id, householdId, itemId, kind, level, message, channels.join('+'));
  const title = `KeepFresh · ${level}`;
  if (cfg.email_on) await sendEmail(user, title, message, {
    type: kind === 'announcement' ? 'announcement' : 'warning',
    alert_level: level, warning_level: level, alert_kind: kind,
  });
  if (cfg.push_on) await sendPush(user, title, message);
}
