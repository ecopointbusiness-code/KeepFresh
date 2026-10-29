import { useCallback, useEffect, useState } from 'react';
import { makeApi } from '../api.js';
import { Logo, LogoFull, Toast, Sheet, Badge, Err, guard, toast, emoji, timeText, PasswordInput } from '../common.jsx';

const api = makeApi('kf-admin-token');
const TABS = [['Overview', '📊'], ['Users', '👥'], ['Devices', '📟'], ['Library', '📖'], ['Shelf life', '⏱️'], ['Advisory', '📣']];

export default function Admin() {
  const [authed, setAuthed] = useState(!!api.token.get());
  const out = () => { api.token.clear(); setAuthed(false); };
  useEffect(() => { api.onExpired = out; }, []);
  return <><Toast />{authed ? <Panel out={out} /> : <Login onOk={() => setAuthed(true)} />}</>;
}

function Login({ onOk }) {
  const [f, setF] = useState({ email: '', password: '' }), [err, setErr] = useState(''), [busy, setBusy] = useState(false);
  const submit = async (e) => { e.preventDefault(); setBusy(true); await guard(async () => { const d = await api.post('/admin/login', f); api.token.set(d.token); onOk(); }, setErr); setBusy(false); };
  return <div className="auth"><form className="box" onSubmit={submit}>
    <LogoFull /><h1>Admin sign in</h1><p className="sub">Authorized staff only.</p><Err msg={err} />
    <label htmlFor="e">Email</label><input id="e" type="email" required autoComplete="username" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
    <label htmlFor="p">Password</label><PasswordInput id="p" autoComplete="current-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
    <button className="go" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button></form></div>;
}

function Panel({ out }) {
  const [tab, setTab] = useState('Overview'), [sheet, setSheet] = useState(null);
  useEffect(() => { document.body.classList.add('has-nav'); return () => document.body.classList.remove('has-nav'); }, []);
  const View = { Overview, Users, Devices, Library, 'Shelf life': ShelfLife, Advisory }[tab];
  return <><main>
    <div className="top"><Logo admin /><button className="chip" onClick={out}>Sign out</button></div>
    <View open={setSheet} />
  </main>
    <nav aria-label="Admin">{TABS.map(([t, i]) => <button key={t} className={`n${tab === t ? ' on' : ''}`} onClick={() => setTab(t)}><span>{i}</span>{t}</button>)}</nav>
    {sheet && <Sheet onClose={() => setSheet(null)}>{sheet.render(() => setSheet(null))}</Sheet>}</>;
}

function useLoad(path) {
  const [data, setData] = useState(null);
  const load = useCallback(() => api.get(path).then(setData).catch((e) => toast(e.message)), [path]);
  useEffect(() => { load(); }, [load]);
  return [data, load];
}
function Bars({ o, colors }) {
  const ks = Object.keys(o), m = Math.max(1, ...ks.map((k) => o[k]));
  return ks.length ? ks.map((k) => <div className="hb" key={k}><span>{k}</span><div><i style={{ width: `${(o[k] / m) * 100}%`, background: colors?.[k] || 'var(--pri)' }} /></div><b>{o[k]}</b></div>) : <div className="empty">Nothing at risk right now.</div>;
}

function Overview() {
  const [s] = useLoad('/admin/stats'), [a] = useLoad('/admin/audit');
  if (!s) return <div className="empty">Loading…</div>;
  const tiles = [[s.users, 'users'], [s.verified, 'verified'], [s.households, 'households'], [`${s.online}/${s.devices}`, 'devices online'], [s.items, 'items tracked'], [s.discarded, 'items discarded'], [s.alerts, 'alerts sent']];
  return <><div className="stats">{tiles.map(([n, l]) => <div className="stat" key={l}><b>{n}</b>{l}</div>)}</div>
    <div className="two" style={{ marginTop: 12 }}><div className="card"><h3 style={{ margin: '0 0 10px' }}>Items at risk by category</h3><Bars o={s.atRisk} /></div>
      <div className="card"><h3 style={{ margin: '0 0 10px' }}>Alerts by level</h3><Bars o={s.alertsByLevel} colors={{ Advisory: 'var(--g)', Watch: 'var(--y)', Warning: 'var(--o)', Critical: 'var(--r)' }} /></div></div>
    <h2>Recent activity</h2><div className="card">{a?.slice(0, 8).map((x) => <div className="al" key={x.id}><Badge color="green" flow>Admin</Badge><div>{x.action}<small>{x.email || 'system'} · {timeText(x.created_at)}</small></div></div>)}{a && !a.length && <div className="empty">No activity yet.</div>}</div></>;
}

function Users({ open }) {
  const [users, load] = useLoad('/admin/users'), [q, setQ] = useState('');
  const toggle = (u) => guard(async () => { await api.patch(`/admin/users/${u.id}`, { active: !u.active }); await load(); toast(u.active ? 'User suspended.' : 'User activated.'); });
  const l = (users || []).filter((u) => (u.name + u.email + (u.household || '')).toLowerCase().includes(q.toLowerCase()));
  return <><div className="search"><span>🔍</span><input placeholder="Search users" aria-label="Search users" value={q} onChange={(e) => setQ(e.target.value)} /></div>
    <button className="go" style={{ margin: '0 0 12px' }} onClick={() => open({ render: (c) => <NewAdmin close={c} /> })}>+ Add admin</button>
    <div className="card tw"><table className="tbl"><thead><tr><th>Name</th><th>Household</th><th>Items</th><th>Email</th><th>Status</th><th /></tr></thead><tbody>
      {l.map((u) => <tr key={u.id}><td><b>{u.name}</b><br /><small className="hint">{u.email}</small></td><td>{u.household}</td><td>{u.items}</td>
        <td><Badge color={u.verified ? 'green' : 'yellow'} flow>{u.verified ? 'Verified' : 'Unverified'}</Badge></td>
        <td><Badge color={u.active ? 'green' : 'red'} flow>{u.active ? 'Active' : 'Suspended'}</Badge></td>
        <td><button className="add mini" onClick={() => toggle(u)}>{u.active ? 'Suspend' : 'Activate'}</button></td></tr>)}</tbody></table>
      {users && !l.length && <div className="empty">No users found.</div>}</div></>;
}
function NewAdmin({ close }) {
  const [f, setF] = useState({ name: '', email: '', password: '' }), [err, setErr] = useState('');
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return <form onSubmit={async (e) => { e.preventDefault(); await guard(async () => { await api.post('/admin/admins', f); toast('Admin created.'); close(); }, setErr); }}><h2 style={{ marginTop: 0 }}>Add admin</h2><Err msg={err} />
    <label htmlFor="n">Name</label><input id="n" required value={f.name} onChange={set('name')} /><label htmlFor="e">Email</label><input id="e" type="email" required value={f.email} onChange={set('email')} />
    <label htmlFor="p">Password (10+ characters)</label><PasswordInput id="p" minLength={10} autoComplete="new-password" value={f.password} onChange={set('password')} /><button className="go">Create admin</button></form>;
}

function Devices({ open }) {
  const [devs, load] = useLoad('/admin/devices');
  useEffect(() => { const timer = setInterval(load, 10000); return () => clearInterval(timer); }, [load]);
  const cmd = (d, c) => guard(async () => { await api.post(`/admin/devices/${d.id}/command`, { cmd: c }); toast(`${c === 'test' ? 'Light test' : c === 'buzz' ? 'Buzzer test' : 'Restart'} queued. The unit runs it on its next check-in.`); await load(); });
  const del = (d) => confirm(`Remove ${d.code}?`) && guard(async () => { await api.del(`/admin/devices/${d.id}`); await load(); });
  return <><button className="go" style={{ margin: '0 0 12px' }} onClick={() => open({ render: (c) => <NewDevice close={c} done={load} /> })}>+ Register device</button>
    {(devs || []).map((d) => <div className="card" key={d.id}><div className="gh"><div><h3 style={{ margin: 0 }}>{d.code}</h3><span className="hint">{d.household || 'Not linked to a household'} · firmware {d.fw}</span></div><Badge color={d.online ? 'green' : 'yellow'} flow>{d.online ? 'Online' : 'Offline'}</Badge></div>
      <p className="hint" style={{ margin: '8px 0' }}>Last seen: {d.lastSeen ? timeText(d.lastSeen) : 'never'}{d.pending ? ` · pending: ${d.pending}` : ''}</p>
      <div className="act"><button onClick={() => cmd(d, 'test')}>Test lights</button><button onClick={() => cmd(d, 'buzz')}>Sound buzzer</button><button onClick={() => cmd(d, 'restart')}>Restart</button><button className="danger" onClick={() => del(d)}>Remove</button></div></div>)}
    {devs && !devs.length && <div className="card empty">No devices registered yet.</div>}</>;
}
function NewDevice({ close, done }) {
  const [code, setCode] = useState(''), [res, setRes] = useState(null), [err, setErr] = useState('');
  if (res) return <><h2 style={{ marginTop: 0 }}>Device registered</h2><p>Device code (give this to the customer): <b>{res.code}</b></p><p>API key for the ESP32 firmware:</p><input readOnly value={res.apiKey} onFocus={(e) => e.target.select()} /><p className="hint">{res.note}</p><button className="go" onClick={() => { done(); close(); }}>Done</button></>;
  return <form onSubmit={async (e) => { e.preventDefault(); await guard(async () => setRes(await api.post('/admin/devices', { code })), setErr); }}><h2 style={{ marginTop: 0 }}>Register device</h2><Err msg={err} />
    <label htmlFor="c">Device code <span className="hint">(optional, generated if empty)</span></label><input id="c" placeholder="KF-0001" value={code} onChange={(e) => setCode(e.target.value)} /><button className="go">Register</button></form>;
}

function Library({ open }) {
  const [rs, load] = useLoad('/admin/recipes');
  const pub = (r) => guard(async () => { await api.patch(`/admin/recipes/${r.id}`, { published: !r.published }); await load(); });
  const del = (r) => confirm(`Delete ${r.name}?`) && guard(async () => { await api.del(`/admin/recipes/${r.id}`); await load(); });
  return <><button className="go" style={{ margin: '0 0 12px' }} onClick={() => open({ render: (c) => <NewRecipe close={c} done={load} /> })}>+ Add recipe</button>
    {(rs || []).map((r) => <div className="row" key={r.id}><div className="pic" style={{ background: r.color, width: 64, height: 64, fontSize: 32 }}>{r.emoji}</div><div className="m"><h3>{r.name}</h3><p>{r.ings} ingredients · {r.steps} steps · {r.time}{r.custom ? ' · custom' : ''}</p></div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}><button className={`sw${r.published ? ' on' : ''}`} aria-label="Published" onClick={() => pub(r)} />{r.custom ? <button className="add mini" onClick={() => del(r)}>Delete</button> : <span className="hint">{r.published ? 'Live' : 'Hidden'}</span>}</div></div>)}</>;
}
function NewRecipe({ close, done }) {
  const [f, setF] = useState({ name: '', emoji: '🍽️', time: '', servings: 4, ing: '', steps: '' }), [err, setErr] = useState('');
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = async (e) => { e.preventDefault(); await guard(async () => {
    const ingredients = f.ing.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const [k, a] = l.split('|'); return { key: k.trim(), amount: (a || k).trim() }; });
    await api.post('/admin/recipes', { name: f.name, emoji: f.emoji, time: f.time, servings: +f.servings, ingredients, steps: f.steps.split('\n') }); toast('Recipe published.'); done(); close(); }, setErr); };
  return <form onSubmit={submit}><h2 style={{ marginTop: 0 }}>Add recipe</h2><Err msg={err} />
    <label htmlFor="n">Name</label><input id="n" required value={f.name} onChange={set('name')} /><label htmlFor="em">Emoji</label><input id="em" maxLength={4} value={f.emoji} onChange={set('emoji')} />
    <label htmlFor="t">Cooking time</label><input id="t" placeholder="30 min" value={f.time} onChange={set('time')} /><label htmlFor="s">Servings</label><input id="s" type="number" min="1" value={f.servings} onChange={set('servings')} />
    <label htmlFor="i">Ingredients (one per line: name | amount)</label><textarea id="i" rows="4" required placeholder="chicken | 1 kg chicken" value={f.ing} onChange={set('ing')} />
    <label htmlFor="st">Steps (one per line)</label><textarea id="st" rows="4" required value={f.steps} onChange={set('steps')} /><button className="go">Publish recipe</button></form>;
}

function ShelfLife() {
  const [cat, load] = useLoad('/admin/catalog'), [n, setN] = useState(''), [days, setDays] = useState('');
  const set = (c, d) => guard(async () => { await api.put(`/admin/catalog/${c.id}`, { shelf_days: Math.max(1, d) }); await load(); });
  const add = (e) => { e.preventDefault(); guard(async () => { await api.post('/admin/catalog', { category: n, shelf_days: +days }); setN(''); setDays(''); await load(); toast('Category added.'); }); };
  return <div className="card"><h3 style={{ margin: '0 0 4px' }}>Default shelf life (days)</h3><p className="hint">The AI estimate starts from these values, then adapts to each household’s history.</p>
    {(cat || []).map((c) => <div className="set" key={c.id}><span>{emoji(c.category)} {c.category}</span><div className="step"><button onClick={() => set(c, c.shelf_days - 1)}>−</button><b>{c.shelf_days}</b><button onClick={() => set(c, c.shelf_days + 1)}>+</button></div></div>)}
    <form className="gf" style={{ marginTop: 12 }} onSubmit={add}><input required placeholder="New category" aria-label="New category" value={n} onChange={(e) => setN(e.target.value)} /><input required type="number" min="1" placeholder="Days" aria-label="Days" value={days} onChange={(e) => setDays(e.target.value)} /><button className="add">Add</button></form></div>;
}

function Advisory() {
  const [hist, load] = useLoad('/admin/announcements'), [hh] = useLoad('/admin/households'), [f, setF] = useState({ level: 'Advisory', message: '', householdId: '' }), [err, setErr] = useState('');
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const send = async (e) => { e.preventDefault(); await guard(async () => { const r = await api.post('/admin/announcements', { ...f, householdId: f.householdId || undefined }); toast(`Sent to ${r.sentTo} user${r.sentTo === 1 ? '' : 's'} by email and push.`); setF({ ...f, message: '' }); await load(); }, setErr); };
  const col = { Advisory: 'green', Watch: 'yellow', Warning: 'orange', Critical: 'red' };
  return <><div className="card"><h3 style={{ margin: 0 }}>Send an advisory</h3><form onSubmit={send}><Err msg={err} />
    <label htmlFor="l">Level</label><select id="l" value={f.level} onChange={set('level')}>{Object.keys(col).map((l) => <option key={l}>{l}</option>)}</select>
    <label htmlFor="m">Message</label><textarea id="m" rows="3" required maxLength={400} placeholder="e.g. Store raw chicken on the lowest shelf." value={f.message} onChange={set('message')} />
    <label htmlFor="h">Send to</label><select id="h" value={f.householdId} onChange={set('householdId')}><option value="">All households</option>{(hh || []).map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}</select>
    <button className="go">Send by email and push</button></form></div>
    <h2>Sent advisories</h2>{(hist || []).map((a) => <div className="card" key={a.id}><Badge color={col[a.level]} flow>{a.level}</Badge> <small className="hint">{timeText(a.created_at)} · to {a.audience === 'all' ? 'all households' : 'one household'}</small><p style={{ margin: '8px 0 0' }}>{a.message}</p></div>)}{hist && !hist.length && <div className="card empty">No advisories sent yet.</div>}</>;
}
