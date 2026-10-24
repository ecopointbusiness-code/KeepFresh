import { useEffect, useState } from 'react';

export const Logo = ({ admin }) => <div className="logo"><img src="/logo-mark.png" alt="" />Keep <span>Fresh</span>{admin ? ' Admin' : ''}</div>;
export const LogoFull = () => <img className="logo-full" src="/logo.png" alt="Keep Fresh: keeping freshness alive" />;

export const CE = { 'Ground meat': '🥩', Poultry: '🍗', 'Fish & seafood': '🐟', 'Pork or beef cuts': '🥓', 'Leafy vegetables': '🥬', Dairy: '🥛', Eggs: '🥚', Leftovers: '🍱', Other: '🧺' };
export const TILE = { 'Ground meat': '#f7ddd2', Poultry: '#f9ecc9', 'Fish & seafood': '#dcecf5', 'Pork or beef cuts': '#f3d9d3', 'Leafy vegetables': '#e3ebc6', Dairy: '#dfeefa', Eggs: '#f8efc4', Leftovers: '#eee0cf', Other: '#ece8d9' };
export const BC = { green: 'g', yellow: 'y', orange: 'o', red: 'r' };
export const emoji = (c) => CE[c] || '✨';
export const tile = (c) => TILE[c] || '#ece8d9';
export const whenText = (d) => (d < 0 ? `Expired ${-d}d ago` : d === 0 ? 'Expires today' : d === 1 ? 'Expires tomorrow' : `${d} days left`);
export const timeText = (s) => { const d = new Date(String(s).replace(' ', 'T') + (String(s).includes('Z') ? '' : 'Z')); return isNaN(d) ? '' : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); };
export const today = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };

export const toast = (msg) => window.dispatchEvent(new CustomEvent('kf-toast', { detail: msg }));
export function Toast() {
  const [m, setM] = useState('');
  useEffect(() => { let t; const h = (e) => { setM(e.detail); clearTimeout(t); t = setTimeout(() => setM(''), 3200); }; window.addEventListener('kf-toast', h); return () => window.removeEventListener('kf-toast', h); }, []);
  return m ? <div id="toast" role="status" style={{ display: 'block' }}>{m}</div> : null;
}
export function Sheet({ onClose, children }) {
  useEffect(() => { const k = (e) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);
  return <div className="ov show" onMouseDown={(e) => e.target === e.currentTarget && onClose()}><div className="sheet" role="dialog" aria-modal="true">{children}</div></div>;
}
export const Badge = ({ color, children, flow }) => <i className={`badge b-${BC[color] || 'g'}`} style={{ fontStyle: 'normal', ...(flow ? { position: 'static' } : {}) }}>{children}</i>;
export function PasswordInput({ id, value, onChange, autoComplete, minLength }) {
  const [show, setShow] = useState(false);
  return <div className="pw"><input id={id} type={show ? 'text' : 'password'} required minLength={minLength} autoComplete={autoComplete} value={value} onChange={onChange} />
    <button type="button" className="eye" onClick={() => setShow(!show)} aria-label={show ? 'Hide password' : 'Show password'} aria-pressed={show}>{show ? '🙈' : '👁️'}</button></div>;
}
export const Err = ({ msg }) => (msg ? <div className="err" role="alert">{msg}</div> : null);
export async function guard(fn, setErr) { try { setErr && setErr(''); return await fn(); } catch (e) { setErr ? setErr(e.message) : toast(e.message); } }
