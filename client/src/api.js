// Empty on the website (same origin). Set VITE_API_URL when building the Android app.
const BASE = (import.meta.env && import.meta.env.VITE_API_URL) || '';

export function makeApi(tokenKey) {
  const store = {
    get: () => { try { return localStorage.getItem(tokenKey); } catch { return null; } },
    set: (t) => { try { localStorage.setItem(tokenKey, t); } catch {} },
    clear: () => { try { localStorage.removeItem(tokenKey); } catch {} },
  };
  async function req(method, path, body) {
    const t = store.get();
    const r = await fetch(BASE + '/api' + path, { method, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const e = new Error(data.error || 'Something went wrong. Please try again.'); e.status = r.status; e.data = data;
      if (r.status === 401 && t && !path.includes('/login') && api.onExpired) api.onExpired();
      throw e;
    }
    return data;
  }
  const api = { token: store, onExpired: null, get: (p) => req('GET', p), post: (p, b) => req('POST', p, b || {}), put: (p, b) => req('PUT', p, b || {}), patch: (p, b) => req('PATCH', p, b || {}), del: (p) => req('DELETE', p) };
  return api;
}
