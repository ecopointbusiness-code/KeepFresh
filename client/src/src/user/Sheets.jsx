import { useEffect, useState } from 'react';
import { api } from './api.js';
import { Badge, Err, guard, toast, today, emoji, timeText } from '../common.jsx';

export function AlertsSheet({ d, load }) {
  useEffect(() => { if (d.unread) api.post('/alerts/ack-all').then(load).catch(() => {}); }, []); // eslint-disable-line
  return <><h2 style={{ marginTop: 0 }}>Alerts</h2>
    {d.alerts.length ? d.alerts.map((a) => <div className="al" key={a.id}><Badge color={a.color} flow>{a.level}</Badge><div>{a.message}<small>{timeText(a.created_at)} · sent by {a.channels.replace(/\+/g, ', ')}</small></div></div>) : <div className="empty">No alerts yet.</div>}</>;
}

export function AddSheet({ d, load, close, go, setCf }) {
  const [f, setF] = useState({ name: '', category: d.catalog[0]?.category || 'Other', qty: '', bought: today(), expires: '' });
  const [est, setEst] = useState(null), [err, setErr] = useState(''), [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  useEffect(() => { if (f.expires || !f.bought) { setEst(null); return; } setEst(null); let live = true; const t = setTimeout(() => api.post('/predict', { category: f.category, bought: f.bought }).then((x) => live && setEst(x)).catch(() => {}), 800); return () => { live = false; clearTimeout(t); }; }, [f.category, f.bought, f.expires]);
  const submit = async (e) => {
    e.preventDefault(); setBusy(true);
    await guard(async () => { const it = await api.post('/items', { ...f, expires: f.expires || undefined, prediction: !f.expires ? est : undefined }); await load(); toast(it.predicted ? `Added. Expiration estimated for ${it.expires}.` : 'Item added.'); setCf('All'); go('Fridge'); close(); }, setErr);
    setBusy(false);
  };
  return <form onSubmit={submit}><h2 style={{ marginTop: 0 }}>Add groceries</h2><Err msg={err} />
    <label htmlFor="n">Item</label><input id="n" required autoFocus placeholder="e.g. Pork belly" value={f.name} onChange={set('name')} />
    <label htmlFor="c">Category</label><select id="c" value={f.category} onChange={set('category')}>{d.catalog.map((c) => <option key={c.category} value={c.category}>{c.emoji} {c.category}</option>)}</select>
    <label htmlFor="q">Quantity</label><input id="q" placeholder="e.g. 500 g" value={f.qty} onChange={set('qty')} />
    <label htmlFor="b">Date bought</label><input id="b" type="date" required value={f.bought} onChange={set('bought')} />
    <label htmlFor="e">Expiration date <span className="hint">(optional)</span></label><input id="e" type="date" value={f.expires} onChange={set('expires')} />
    {!f.expires && est && <p className="hint">Estimated expiration: <b>{est.expires}</b> ({est.days} days · {est.source === 'AI' ? `AI estimate, ${Math.round(est.confidence * 100)}% confidence` : est.source === 'household history' ? `learned from ${est.samples} household records` : 'reference estimate'}). Food storage estimates are guides, not a safety guarantee.</p>}
    {!f.expires && !est && <p className="hint">KeepFresh is estimating shelf life from food type and refrigerator history.</p>}
    <button className="go" disabled={busy}>{busy ? 'Adding…' : 'Add to refrigerator'}</button></form>;
}

export function RecipeSheet({ d, id, load, open, close, setRsub, go }) {
  const r = d.recipes.find((x) => x.id === id); if (!r) return null;
  const add = async (g) => { await guard(async () => { await api.post('/grocery', { name: g.key, qty: g.amount, why: r.name }); await load(); toast(`${g.key} added to your list.`); }); };
  const addAll = async () => { await guard(async () => { await api.post('/grocery/add-missing', { recipeId: r.id }); await load(); close(); setRsub('Grocery list'); go('Recipes'); toast('Missing ingredients added to your list.'); }); };
  const missing = r.ingredients.filter((g) => !g.have).length;
  return <><div className="rh" style={{ background: r.color }}>{r.emoji}</div><h2 style={{ margin: '14px 0 6px' }}>{r.name}</h2>
    <div className="meta"><span>⏱ {r.time}</span><span>🍽 {r.servings} servings</span><span>{r.ready}/{r.total} ready</span></div>
    <h3>Ingredients</h3>
    {r.ingredients.map((g) => <div className="ing" key={g.key}><b className={g.have ? 'have' : 'buy'}>{g.have ? '✓' : '+'}</b><span>{g.amount}</span>{g.have ? <small className="have">In fridge</small> : <button className="add" onClick={() => add(g)}>Add</button>}</div>)}
    <h3 style={{ marginTop: 16 }}>How to cook</h3><ol className="steps">{r.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
    <button className="go" onClick={() => open({ type: 'cook', id: r.id })}>Start cooking</button>
    {missing > 0 && <button className="go alt" onClick={addAll}>Add all missing to grocery list</button>}</>;
}

export function CookSheet({ d, id, load, close }) {
  const r = d.recipes.find((x) => x.id === id), [k, setK] = useState(0); if (!r) return null;
  const last = k === r.steps.length - 1;
  const finish = async () => { await guard(async () => { const x = await api.post(`/recipes/${r.id}/cook`); await load(); close(); toast(`Enjoy your ${r.name}! ${x.used} fresh item${x.used === 1 ? '' : 's'} marked as used.`); }); };
  return <><p className="hint">{r.emoji} {r.name}</p><div className="bar"><i style={{ width: `${((k + 1) / r.steps.length) * 100}%` }} /></div><p className="hint">Step {k + 1} of {r.steps.length}</p>
    <p className="cs">{r.steps[k]}</p>
    <div className="cbtn"><button className="add" disabled={!k} onClick={() => setK(k - 1)}>Back</button>{last ? <button className="go" style={{ margin: 0 }} onClick={finish}>Finish and mark used</button> : <button className="go" style={{ margin: 0 }} onClick={() => setK(k + 1)}>Next step</button>}</div></>;
}
