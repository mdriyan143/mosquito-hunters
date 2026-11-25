const API = process.env.NEXT_PUBLIC_API_URL || ''; // empty = same origin (Vercel)

async function call(path, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(API + path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

export const getTopScores = (limit = 5, clientId = '') =>
  call(`/api/scores?limit=${limit}${clientId ? `&clientId=${encodeURIComponent(clientId)}` : ''}`);
export const getStats = () => call('/api/stats');
export const submitScore = (payload) => call('/api/scores', { method: 'POST', body: JSON.stringify(payload) });
