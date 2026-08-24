const tokenKey = 'wa_token';

export function getToken() {
  return localStorage.getItem(tokenKey);
}
export function setToken(t) {
  localStorage.setItem(tokenKey, t);
}
export function clearToken() {
  localStorage.removeItem(tokenKey);
}

async function req(path, opts = {}) {
  const token = getToken();
  const res = await fetch(`/api${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers || {}),
    },
  });
  if (res.status === 401) {
    clearToken();
    throw new Error('unauthorized');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'request failed');
  return data;
}

export const api = {
  login: (email, password) => req('/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  conversations: () => req('/conversations'),
  conversation: (id) => req(`/conversations/${id}`),
  send: (id, body) => req(`/conversations/${id}/messages`, { method: 'POST', body: JSON.stringify({ body }) }),
  takeover: (id) => req(`/conversations/${id}/takeover`, { method: 'POST' }),
  handback: (id) => req(`/conversations/${id}/handback`, { method: 'POST' }),
  templates: () => req('/templates'),
  syncTemplates: () => req('/templates/sync', { method: 'POST' }),
  sendTemplate: (id, name, params) =>
    req(`/conversations/${id}/template`, { method: 'POST', body: JSON.stringify({ name, params }) }),

  overview: () => req('/overview'),
  getSettings: () => req('/settings'),
  saveSettings: (body) => req('/settings', { method: 'PUT', body: JSON.stringify(body) }),
  getProfile: () => req('/profile'),
  saveProfile: (body) => req('/profile', { method: 'PUT', body: JSON.stringify(body) }),
  knowledge: () => req('/knowledge'),
  addKnowledge: (title, content) => req('/knowledge', { method: 'POST', body: JSON.stringify({ title, content }) }),
  updateKnowledge: (id, body) => req(`/knowledge/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteKnowledge: (id) => req(`/knowledge/${id}`, { method: 'DELETE' }),
  agents: () => req('/agents'),
  addAgent: (email, name, password) =>
    req('/agents', { method: 'POST', body: JSON.stringify({ email, name, password }) }),
  deleteAgent: (id) => req(`/agents/${id}`, { method: 'DELETE' }),
  media: () => req('/media'),
  sendMedia: (id, assetId, caption) =>
    req(`/conversations/${id}/media`, { method: 'POST', body: JSON.stringify({ assetId, caption }) }),
  audit: () => req('/audit'),
  uploadMedia: async (file) => {
    const token = getToken();
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch('/api/media', {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: fd,
    });
    if (res.status === 401) {
      clearToken();
      throw new Error('unauthorized');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'upload failed');
    return data;
  },
};
