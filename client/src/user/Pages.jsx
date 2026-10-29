import { useEffect, useState } from 'react';
import { api } from './api.js';
import { Logo, Badge, CE, emoji, tile, whenText, guard, toast, Err, Sheet } from '../common.jsx';

const AISLES = ['Meat & poultry', 'Fish & seafood', 'Vegetables & produce', 'Dairy & eggs', 'Pantry & other'];
const AISLE = { Poultry: 0, 'Ground meat': 0, 'Pork or beef cuts': 0, 'Fish & seafood': 1, 'Leafy vegetables': 2, Dairy: 3, Eggs: 3 };

function Top({ d, open }) {
  return <div className="top"><Logo />
    <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}><div className="chip">🏠 {d.me.household.name}</div>
      <button className="bell" onClick={() => open({ type: 'alerts' })} aria-label="Alerts">🔔{d.unread > 0 && <i>{Math.min(d.unread, 9)}</i>}</button></div></div>;
}
const Search = ({ q, setQ }) => <div className="search"><span>🔍</span><input placeholder="Search your refrigerator" aria-label="Search" value={q} onChange={(e) => setQ(e.target.value)} /></div>;
function Chips({ d, cf, setCf, go }) {
  const names = ['All', ...d.catalog.map((c) => c.category)];
  return <div className="cats">{names.map((k) => <button key={k} className={`cat${cf === k ? ' on' : ''}`} onClick={() => { setCf(k); go && go('Fridge'); }}><span>{k === 'All' ? '✨' : emoji(k)}</span><small>{k === 'Pork or beef cuts' ? 'Pork & beef' : k === 'Leafy vegetables' ? 'Veggies' : k}</small></button>)}</div>;
}
function ItemCard({ it, i, load, removeItem }) {
  const [choice, setChoice] = useState(null), [busy, setBusy] = useState(false);
  const finish = (outcome) => guard(async () => {
    setBusy(true);
    try {
      try { await api.del(`/items/${it.id}?outcome=${outcome}`); }
      catch (error) {
        if (error.status === 404) await load();
        throw error;
      }
      removeItem(it.id);
      setChoice(null);
      await load();
      toast('Removed from your refrigerator and recorded.');
    } finally { setBusy(false); }
  });
  const snooze = () => guard(async () => {
    setBusy(true);
    try {
      await api.post(`/items/${it.id}/dismiss`);
      setChoice(null);
      await load();
      toast('Warning dismissed for today. It will return tomorrow if still at risk.');
    } finally { setBusy(false); }
  });
  return <><div className="it" style={{ animationDelay: `${i * 40}ms` }}><div className="pic" style={{ background: tile(it.category) }}>{emoji(it.category)}<Badge color={it.color}>{it.label}</Badge></div>
    <h3>{it.name}</h3><p className="sub">{it.category} · {it.qty}</p><p className="sub" style={{ color: `var(--${{ green: 'g', yellow: 'y', orange: 'o', red: 'r' }[it.color]})` }}>{whenText(it.daysLeft)}{it.predicted ? ` · ${it.predictionSource === 'AI' ? 'AI estimate' : `${it.predictionSource} estimate`}` : ''}</p>
    <div className="act"><button onClick={() => setChoice('used')}>Used</button><button onClick={() => setChoice('discard')}>Discard</button></div></div>
    {choice && <Sheet onClose={() => !busy && setChoice(null)}>
      {choice === 'used' ? <>
        <h2>Are you sure?</h2><p>Remove <strong>{it.name}</strong> from your refrigerator and mark it as used?</p>
        <div className="cbtn"><button className="add" disabled={busy} onClick={() => setChoice(null)}>No</button><button className="go" style={{ margin: 0 }} disabled={busy} onClick={() => finish('consumed')}>{busy ? 'Saving…' : 'Yes, mark as used'}</button></div>
      </> : <>
        <h2>Did you use this?</h2><p><strong>{it.name}</strong> will be removed if you did. If you did not use it, it will stay in your refrigerator and this warning will return tomorrow if it is still at risk.</p>
        <div className="cbtn"><button className="add" disabled={busy} onClick={snooze}>{busy ? 'Saving…' : 'No, keep it'}</button><button className="go" style={{ margin: 0 }} disabled={busy} onClick={() => finish('consumed')}>{busy ? 'Saving…' : 'Yes, I used it'}</button></div>
      </>}
    </Sheet>}
  </>;
}
function Device({ items }) {
  const att = items.filter((i) => i.level !== 'Advisory' && !i.dismissedToday), w = att.some((i) => i.level === 'Critical') ? 'r' : att.length ? 'y' : 'g';
  return <div className="dev"><div className="lights" aria-hidden="true">{['g', 'y', 'r'].map((c) => <b key={c} className={`${c}${w === c ? ' on' : ''}`} />)}</div>
      <div className="scr"><div className="t">KeepFresh KF-1 · Indicator Unit{w === 'r' ? ' · BUZZER' : ''}</div>
      {att.length ? att.slice(0, 4).map((i) => <div key={i.id} className={i.daysLeft < 0 ? 'c' : 'w'}>{i.name} — {i.daysLeft < 0 ? 'EXPIRED' : `${i.daysLeft}d left`}</div>) : <div>All items fresh</div>}
      <div style={{ color: '#8ea05a', marginTop: 8 }}>Live from your refrigerator door</div></div></div>;
}

export function Home(p) {
  const { d, q, setQ } = p, att = d.items.filter((i) => i.level !== 'Advisory' && !i.dismissedToday);
  return <><Top {...p} /><Search q={q} setQ={(v) => { setQ(v); p.go('Fridge'); }} />
    <div className="two"><div className="hero"><h1>Hello, {d.me.user.firstName}</h1><p>{att.length ? `${att.length} item${att.length > 1 ? 's need' : ' needs'} your attention today.` : 'Everything in your refrigerator is fresh.'}</p><button className="btn" onClick={() => p.go('Recipes')}>Cook with them</button><div className="big">🧊</div></div><Device items={d.items} /></div>
    <h2>Categories <button onClick={() => { p.setCf('All'); p.go('Fridge'); }}>View all</button></h2><Chips {...p} />
    <h2>Use these first</h2>{att.length ? <div className="cards">{att.map((it, i) => <ItemCard key={it.id} it={it} i={i} load={p.load} removeItem={p.removeItem} />)}</div> : <div className="card empty">Nothing is about to spoil. Nice work!</div>}
    <h2>Recent alerts <button onClick={() => p.open({ type: 'alerts' })}>See all</button></h2>
    <div className="card">{d.alerts.slice(0, 3).map((a) => <div className="al" key={a.id}><Badge color={a.color} flow>{a.level}</Badge><div>{a.message}</div></div>)}{!d.alerts.length && <div className="empty">No alerts yet.</div>}</div></>;
}

export function Fridge(p) {
  const { d, q, setQ, cf } = p, l = d.items.filter((i) => (cf === 'All' || i.category === cf) && i.name.toLowerCase().includes(q.toLowerCase()));
  return <><Top {...p} /><Search q={q} setQ={setQ} /><Chips {...p} /><h2>My refrigerator <small className="hint">{l.length} items</small></h2>
    {l.length ? <div className="cards">{l.map((it, i) => <ItemCard key={it.id} it={it} i={i} load={p.load} removeItem={p.removeItem} />)}</div> : <div className="card empty">No items here yet. Tap + to add groceries.</div>}</>;
}

export function Recipes(p) {
  const { d, rsub, setRsub } = p;
  return <><Top {...p} /><div className="seg">{['Recipes', 'Grocery list'].map((s) => <button key={s} className={rsub === s ? 'on' : ''} onClick={() => setRsub(s)}>{s}</button>)}</div>{rsub === 'Recipes' ? <RecipeList {...p} /> : <Grocery {...p} />}</>;
}
function RecipeList({ d, open, load }) {
  const [busy, setBusy] = useState(false);
  const generate = async () => {
    setBusy(true);
    await guard(async () => { const result = await api.post('/recipes/suggest', {}); await load(); toast(result.generated ? 'Created ' + result.generated + ' fridge-matched recipe suggestion' + (result.generated === 1 ? '' : 's') + '.' : 'No recipe matched the ingredients currently in your fridge.'); });
    setBusy(false);
  };
  return <><div className="card" style={{ marginBottom: 16 }}><div className="gh"><div><h2 style={{ margin: 0 }}>Cook with what you have</h2><p className="hint" style={{ margin: '6px 0 0' }}>{'Suggestions are matched to fresh ingredients in your refrigerator, with detailed cooking steps.'}</p></div><button className="btn" disabled={busy || !d.items.some((it) => it.daysLeft >= 0)} onClick={generate}>{busy ? 'Finding matches…' : '✨ Suggest recipes'}</button></div></div>
    {d.recipes.length > 0 ? <><div className="banners">{d.recipes.slice(0, 3).map((r) => <div className="ban" key={r.id} style={{ background: r.color }}><h3>{r.name}</h3><p>{r.soon.length ? 'Uses ' + r.soon.join(', ') + ' before it spoils' : 'You have ' + r.ready + ' of ' + r.total + ' ingredients'}</p><button onClick={() => open({ type: 'recipe', id: r.id })}>View recipe</button><div className="big">{r.emoji}</div></div>)}</div>
    <h2>Suggestions that fit your refrigerator</h2>
    {d.recipes.map((r) => { const m = r.ingredients.filter((g) => !g.have).map((g) => g.key); return <div className="row" key={r.id}><div className="pic" style={{ background: r.color }}>{r.emoji}</div><div className="m"><h3>{r.name} {r.aiGenerated ? <small className="hint">AI suggestion</small> : <small className="hint">Fridge match</small>}</h3><p>{r.ready} of {r.total} ingredients ready · ⏱ {r.time}</p><p className={m.length ? 'buy' : 'have'}>{m.length ? 'Also needed: ' + m.slice(0, 3).join(', ') + (m.length > 3 ? '…' : '') : 'Ready to cook'}</p></div><button className="add" onClick={() => open({ type: 'recipe', id: r.id })}>View</button></div>; })}</> : <div className="card empty">No recipe suggestions yet. Add fresh ingredients, then get recipe ideas that use food already in your refrigerator as the main ingredient.</div>}</>;
}
function Grocery({ d, load }) {
  const [n, setN] = useState(''), [qty, setQty] = useState(''), { list, suggestions } = d.grocery, done = list.filter((g) => g.done).length;
  const call = (fn, msg) => guard(async () => { await fn(); await load(); msg && toast(msg); });
  const add = (e) => { e.preventDefault(); call(() => api.post('/grocery', { name: n, qty }), null).then(() => { setN(''); setQty(''); }); };
  const share = async () => { const t = 'KeepFresh grocery list\n' + list.map((g) => `${g.done ? '[x]' : '[ ]'} ${g.qty ? g.qty + ' ' : ''}${g.name}`).join('\n'); try { if (navigator.share) await navigator.share({ text: t }); else { await navigator.clipboard.writeText(t); toast('List copied. Paste it into a message.'); } } catch { /* cancelled */ } };
  return <><div className="card"><div className="gh"><div><h3 style={{ margin: 0 }}>This week’s list</h3><span className="hint">{done} of {list.length} in the basket</span></div><button className="add" onClick={share}>Share</button></div>
    <div className="bar"><i style={{ width: `${list.length ? (done / list.length) * 100 : 0}%` }} /></div>
    <form className="gf" onSubmit={add}><input required placeholder="Add an item, e.g. Rice" aria-label="Item name" value={n} onChange={(e) => setN(e.target.value)} /><input placeholder="Qty" aria-label="Quantity" value={qty} onChange={(e) => setQty(e.target.value)} /><button className="add">Add</button></form>
    {list.length ? AISLES.map((a, ai) => { const rows = list.filter((g) => (AISLE[g.category] ?? 4) === ai); return rows.length ? <div key={a}><div className="ai">{a}</div>{rows.map((g) => <div className={`chk${g.done ? ' done' : ''}`} key={g.id}><input type="checkbox" checked={g.done} aria-label={g.name} onChange={(e) => call(() => api.patch(`/grocery/${g.id}`, { done: e.target.checked }))} /><span>{g.name}{g.qty && <small className="hint"> {g.qty}</small>}<small className="hint" style={{ display: 'block' }}>{g.why}</small></span><button className="x" aria-label="Remove" onClick={() => call(() => api.del(`/grocery/${g.id}`))}>×</button></div>)}</div> : null; }) : <div className="empty">Your list is empty. Add suggestions below or type an item.</div>}
    {done > 0 && <><button className="go" onClick={() => call(() => api.post('/grocery/move-bought'), 'Bought items moved to your refrigerator.')}>Move {done} bought item{done > 1 ? 's' : ''} to refrigerator</button><button className="go alt" onClick={() => call(() => api.post('/grocery/clear-checked'))}>Clear checked</button></>}</div>
    <div className="card"><h3 style={{ margin: '0 0 8px' }}>Suggested for you</h3>{suggestions.length ? <><div className="pills">{suggestions.map((s) => <button key={s.name} onClick={() => call(() => api.post('/grocery', s))}>+ {s.name}</button>)}</div><button className="add" style={{ marginTop: 12 }} onClick={() => call(() => api.post('/grocery/add-suggested'), 'Added to your list.')}>Add all</button></> : <span className="hint">Nothing more to suggest.</span>}</div></>;
}

const b64 = (s) => { const p = '='.repeat((4 - (s.length % 4)) % 4), r = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from([...r].map((c) => c.charCodeAt(0))); };
export function Profile(p) {
  const { d, load, onLogout } = p, s = d.me.settings, [code, setCode] = useState(''), [err, setErr] = useState(''), [devs, setDevs] = useState(null);
  useEffect(() => { api.get('/household').then((h) => setDevs(h.devices)).catch(() => setDevs([])); }, []);
  const save = (patch) => guard(async () => { await api.put('/settings', patch); await load(); });
  const Step = ({ k, min, max }) => <div className="step"><button onClick={() => save({ [k]: Math.max(min, s[k] - 1) })}>−</button><b>{s[k]}</b><button onClick={() => save({ [k]: Math.min(max, s[k] + 1) })}>+</button></div>;
  const push = () => guard(async () => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('This browser does not support push notifications. On iPhone, add KeepFresh to your Home Screen first.');
    const { key } = await api.get('/push/key'); if (!key) throw new Error('Push notifications are not set up on this server yet.');
    if ((await Notification.requestPermission()) !== 'granted') throw new Error('Notifications are blocked. Allow them in your browser settings.');
    const reg = await navigator.serviceWorker.ready, sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(key) }));
    await api.post('/push/subscribe', { subscription: sub.toJSON() }); await save({ push_on: true }); toast('Push notifications are on for this device.');
  });
  const link = async (e) => { e.preventDefault(); await guard(async () => { await api.post('/household/device', { code }); setCode(''); setDevs((await api.get('/household')).devices); toast('Indicator Unit linked.'); }, setErr); };
  const m = d.me;
  return <><Top {...p} />
    <div className="card"><h3 style={{ margin: 0 }}>{m.user.name}</h3><span className="hint">{m.user.email}</span><p style={{ margin: '10px 0 0' }}>Household invite code: <b style={{ letterSpacing: '.1em' }}>{m.household.inviteCode}</b><br /><span className="hint">Share it so family members can join the same refrigerator. Members: {m.household.members.map((x) => x.name).join(', ')}</span></p></div>
    <div className="card"><h3 style={{ margin: '0 0 4px' }}>Alert settings</h3>
      <div className="set"><span>Yellow watch<br /><small className="hint">days before expiry</small></span><Step k="watch_days" min={1} max={14} /></div>
      <div className="set"><span>Orange warning<br /><small className="hint">days before expiry</small></span><Step k="warn_days" min={0} max={7} /></div>
      <div className="set"><span>Email alerts{!m.emailEnabled && <small className="hint" style={{ display: 'block' }}>Server email is not configured</small>}</span><button className={`sw${s.email_on ? ' on' : ''}`} aria-label="Email alerts" onClick={() => save({ email_on: !s.email_on })} /></div>
      <div className="set"><span>Push notifications<br /><small className="hint">Warnings on this phone</small></span><button className="add" onClick={push}>Turn on</button></div></div>
    <div className="card"><h3 style={{ margin: '0 0 6px' }}>Indicator Unit</h3>{devs?.length ? devs.map((v) => <div className="set" key={v.id}><span>{v.code}<br /><small className="hint">firmware {v.fw}</small></span><Badge color={v.online ? 'green' : 'yellow'} flow>{v.online ? 'Online' : 'Offline'}</Badge></div>) : <p className="hint">No device linked yet.</p>}
      <Err msg={err} /><form className="gf" onSubmit={link}><input required placeholder="Device code, e.g. KF-1A2B3C" aria-label="Device code" value={code} onChange={(e) => setCode(e.target.value)} /><button className="add">Link</button></form></div>
    <button className="go alt" onClick={onLogout}>Log out</button></>;
}


