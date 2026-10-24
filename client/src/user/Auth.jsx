import { useEffect, useState } from 'react';
import { api } from './api.js';
import { Err, guard, PasswordInput, LogoFull } from '../common.jsx';

export default function Auth({ onAuthed }) {
  const [mode, setMode] = useState('login'); // login | signup | verify | forgot | reset
  const [f, setF] = useState({ firstName: '', middleName: '', lastName: '', email: '', password: '', householdName: '', inviteCode: '', code: '' });
  const [join, setJoin] = useState(false);
  const [err, setErr] = useState(''), [info, setInfo] = useState(''), [busy, setBusy] = useState(false), [cool, setCool] = useState(0);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  useEffect(() => { if (cool <= 0) return; const t = setTimeout(() => setCool(cool - 1), 1000); return () => clearTimeout(t); }, [cool]);

  const submit = (fn) => async (e) => { e.preventDefault(); setBusy(true); await guard(fn, setErr); setBusy(false); };

  const login = submit(async () => {
    try { const d = await api.post('/auth/login', { email: f.email, password: f.password }); api.token.set(d.token); onAuthed(); }
    catch (e) { if (e.data?.needsVerification) { setMode('verify'); setInfo(`We sent a 6-digit code to ${e.data.email}.`); setCool(30); } else throw e; }
  });
  const signup = submit(async () => {
    const d = await api.post('/auth/register', { firstName: f.firstName, middleName: f.middleName, lastName: f.lastName, email: f.email, password: f.password, ...(join ? { inviteCode: f.inviteCode } : { householdName: f.householdName }) });
    setMode('verify'); setInfo(`We sent a 6-digit code to ${d.email}. It expires in 15 minutes.`); setCool(30);
  });
  const verify = submit(async () => { const d = await api.post('/auth/verify', { email: f.email, code: f.code }); api.token.set(d.token); onAuthed(); });
  const resend = async () => { await guard(async () => { const d = await api.post('/auth/resend', { email: f.email }); setInfo('A new code is on its way.'); setCool(30); }, setErr); };
  const forgot = submit(async () => { const d = await api.post('/auth/forgot', { email: f.email }); setMode('reset'); setInfo('If that email has an account, we sent a reset code.'); });
  const reset = submit(async () => { await api.post('/auth/reset', { email: f.email, code: f.code, password: f.password }); setMode('login'); setInfo('Password updated. You can log in now.'); setF({ ...f, password: '', code: '' }); });
  const go = (m) => { setMode(m); setErr(''); setInfo(''); };

  return (
    <div className="auth"><div className="box">
      <LogoFull />
      {(mode === 'login' || mode === 'signup') && <div className="seg" style={{ marginTop: 16 }}><button className={mode === 'login' ? 'on' : ''} onClick={() => go('login')}>Log in</button><button className={mode === 'signup' ? 'on' : ''} onClick={() => go('signup')}>Sign up</button></div>}
      <Err msg={err} />{info && <div className="note">{info}</div>}

      {mode === 'login' && <form onSubmit={login}>
        <h1>Welcome back</h1><p className="sub">Log in to see what is in your refrigerator.</p>
        <label htmlFor="e">Email</label><input id="e" type="email" autoComplete="email" required value={f.email} onChange={set('email')} />
        <label htmlFor="p">Password</label><PasswordInput id="p" autoComplete="current-password" value={f.password} onChange={set('password')} />
        <button className="go" disabled={busy}>{busy ? 'Logging in…' : 'Log in'}</button>
        <p style={{ textAlign: 'center' }}><button type="button" className="link" onClick={() => go('forgot')}>Forgot password?</button></p>
      </form>}

      {mode === 'signup' && <form onSubmit={signup}>
        <h1>Create your account</h1><p className="sub">Track groceries, get warnings, and cook before food spoils.</p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div><label htmlFor="fn">First name</label><input id="fn" required autoComplete="given-name" value={f.firstName} onChange={set('firstName')} /></div>
          <div><label htmlFor="ln">Last name</label><input id="ln" required autoComplete="family-name" value={f.lastName} onChange={set('lastName')} /></div>
        </div>
        <label htmlFor="mn">Middle name <span className="hint">(optional)</span></label><input id="mn" autoComplete="additional-name" value={f.middleName} onChange={set('middleName')} />
        <label htmlFor="e">Email</label><input id="e" type="email" autoComplete="email" required value={f.email} onChange={set('email')} />
        <label htmlFor="p">Password (at least 8 characters)</label><PasswordInput id="p" minLength={8} autoComplete="new-password" value={f.password} onChange={set('password')} />
        <label>Household</label>
        <div className="opt"><button type="button" className={!join ? 'on' : ''} onClick={() => setJoin(false)}>Create new</button><button type="button" className={join ? 'on' : ''} onClick={() => setJoin(true)}>Join with code</button></div>
        {join ? <input aria-label="Invite code" placeholder="Invite code from a family member" required value={f.inviteCode} onChange={set('inviteCode')} /> : <input aria-label="Household name" placeholder="e.g. Santos household (optional)" value={f.householdName} onChange={set('householdName')} />}
        <button className="go" disabled={busy}>{busy ? 'Creating…' : 'Create account'}</button>
      </form>}

      {mode === 'verify' && <form onSubmit={verify}>
        <h1>Verify your email</h1><p className="sub">Enter the 6-digit code we emailed to <b>{f.email}</b>.</p>
        <label htmlFor="c">Verification code</label><input id="c" className="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} required value={f.code} onChange={set('code')} />
        <button className="go" disabled={busy || f.code.length < 6}>{busy ? 'Checking…' : 'Verify and continue'}</button>
        <p style={{ textAlign: 'center' }}><button type="button" className="link" disabled={cool > 0} onClick={resend}>{cool > 0 ? `Resend code in ${cool}s` : 'Resend code'}</button> · <button type="button" className="link" onClick={() => go('login')}>Back</button></p>
      </form>}

      {mode === 'forgot' && <form onSubmit={forgot}>
        <h1>Reset your password</h1><p className="sub">We will email you a code.</p>
        <label htmlFor="e">Email</label><input id="e" type="email" required value={f.email} onChange={set('email')} />
        <button className="go" disabled={busy}>Send reset code</button>
        <p style={{ textAlign: 'center' }}><button type="button" className="link" onClick={() => go('login')}>Back to log in</button></p>
      </form>}

      {mode === 'reset' && <form onSubmit={reset}>
        <h1>Choose a new password</h1>
        <label htmlFor="c">Reset code</label><input id="c" className="code" inputMode="numeric" maxLength={6} required value={f.code} onChange={set('code')} />
        <label htmlFor="p">New password</label><PasswordInput id="p" minLength={8} autoComplete="new-password" value={f.password} onChange={set('password')} />
        <button className="go" disabled={busy}>Update password</button>
      </form>}
    </div></div>
  );
}
