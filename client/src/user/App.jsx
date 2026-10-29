import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import Auth from './Auth.jsx';
import { Home, Fridge, Recipes, Profile } from './Pages.jsx';
import { AddSheet, AlertsSheet, RecipeSheet, CookSheet } from './Sheets.jsx';
import { Toast, Sheet } from '../common.jsx';

const TABS = [['Home', '🏠'], ['Fridge', '🧊'], ['+'], ['Recipes', '🍳'], ['Profile', '👤']];

export default function App() {
  const [authed, setAuthed] = useState(!!api.token.get());
  const logout = () => { api.token.clear(); setAuthed(false); };
  useEffect(() => { api.onExpired = logout; }, []);
  return <><Toast />{authed ? <Shell onLogout={logout} /> : <Auth onAuthed={() => setAuthed(true)} />}</>;
}

function Shell({ onLogout }) {
  const [d, setD] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [tab, setTab] = useState('Home'), [cf, setCf] = useState('All'), [q, setQ] = useState(''), [sheet, setSheet] = useState(null), [rsub, setRsub] = useState('Recipes');
  const load = useCallback(async () => {
    try {
      const [me, items, al, catalog, recipes, grocery] = await Promise.all([api.get('/me'), api.get('/items'), api.get('/alerts'), api.get('/catalog'), api.get('/recipes'), api.get('/grocery')]);
      setD({ me, items, alerts: al.alerts, unread: al.unread, catalog, recipes, grocery });
      setLoadError('');
    } catch (e) {
      setLoadError(e.message || 'The server could not load your refrigerator.');
      throw e;
    }
  }, []);
  useEffect(() => { document.body.classList.add('has-nav'); return () => document.body.classList.remove('has-nav'); }, []);
  useEffect(() => { load().catch(() => {}); const t = setInterval(() => load().catch(() => {}), 60000); return () => clearInterval(t); }, [load]);
  if (!d) return <div className="auth"><div className="box"><h1>KeepFresh</h1>{loadError ? <><p className="err">{loadError}</p><button className="btn d" onClick={() => load().catch(() => {})}>Try again</button></> : <div className="empty">Loading your refrigerator…</div>}</div></div>;

  const removeItem = (id) => setD((current) => current ? { ...current, items: current.items.filter((item) => item.id !== id) } : current);
  const ctx = { d, load, removeItem, q, setQ, cf, setCf, go: setTab, open: setSheet, rsub, setRsub, onLogout };
  const close = () => setSheet(null);
  const Page = { Home, Fridge, Recipes, Profile }[tab];
  return (
    <>
      <main><Page {...ctx} /></main>
      <nav aria-label="Main">
        {TABS.map((t) => t[0] === '+'
          ? <button key="+" className="fab" onClick={() => setSheet({ type: 'add' })} aria-label="Add groceries"><span>+</span><em className="lbl">Add groceries</em></button>
          : <button key={t[0]} className={`n${tab === t[0] ? ' on' : ''}`} onClick={() => { setTab(t[0]); window.scrollTo(0, 0); }}><span>{t[1]}</span>{t[0]}</button>)}
      </nav>
      {sheet && <Sheet onClose={close}>
        {sheet.type === 'add' && <AddSheet {...ctx} close={close} />}
        {sheet.type === 'alerts' && <AlertsSheet {...ctx} close={close} />}
        {sheet.type === 'recipe' && <RecipeSheet {...ctx} id={sheet.id} close={close} />}
        {sheet.type === 'cook' && <CookSheet {...ctx} id={sheet.id} close={close} />}
      </Sheet>}
    </>
  );
}
