import { all, get, run } from './db.js';
import { levelFor, describe } from './levels.js';
import { deliver } from './notify.js';
import { daysLeft, today, iso } from './util.js';

export const settingsOf = async (uid) => {
  let s = await get('SELECT * FROM settings WHERE user_id=?', uid);
  if (!s) { await run('INSERT INTO settings (user_id) VALUES (?) ON CONFLICT (user_id) DO NOTHING', uid); s = await get('SELECT * FROM settings WHERE user_id=?', uid); }
  return s;
};

/** Compare every item with each member's thresholds and send an alert when its level changes. */
export async function checkHousehold(hid) {
  const users = await all("SELECT * FROM users WHERE household_id=? AND active=1 AND role='user'", hid);
  const items = await all('SELECT * FROM items WHERE household_id=?', hid);
  let sent = 0;
  for (const u of users) {
    const cfg = await settingsOf(u.id);
    for (const it of items) {
      const level = levelFor(daysLeft(it.expires), cfg);
      const prev = await get('SELECT level FROM alert_state WHERE user_id=? AND item_id=?', u.id, it.id);
      const dismissal = /^dismissed:(\d{4}-\d{2}-\d{2}):/i.exec(prev?.level || '');
      if (dismissal?.[1] === iso(today())) continue;
      if (!dismissal && prev?.level === level) continue;
      await run('INSERT INTO alert_state (user_id,item_id,level) VALUES (?,?,?) ON CONFLICT (user_id,item_id) DO UPDATE SET level=excluded.level', u.id, it.id, level);
      if (level === 'Advisory') continue;
      await deliver(u, cfg, { level, message: describe(it, level), householdId: hid, itemId: it.id });
      sent++;
    }
  }
  await run('DELETE FROM alert_state WHERE item_id NOT IN (SELECT id FROM items)');
  return sent;
}

export async function checkAll() {
  let n = 0;
  for (const h of await all('SELECT id FROM households')) n += await checkHousehold(h.id);
  return n;
}

export function startScheduler() {
  const mins = Number(process.env.CHECK_MINUTES || 15);
  checkAll().catch((e) => console.warn('[checker]', e.message));
  return setInterval(() => checkAll().catch((e) => console.warn('[checker]', e.message)), mins * 60 * 1000);
}
