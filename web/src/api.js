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

export function getAgentEmail() {
  try {
    const token = getToken();
    if (!token) return null;
    const payload = JSON.parse(atob(token.split('.')[1]));
    return payload.email || null;
  } catch {
    return null;
  }
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
  conversations: (opts = {}) => req(`/conversations${opts.archived ? '?archived=1' : ''}`),
  pinConversation: (id, on) => req(`/conversations/${id}/pin`, { method: 'POST', body: JSON.stringify({ on }) }),
  archiveConversation: (id, on) => req(`/conversations/${id}/archive`, { method: 'POST', body: JSON.stringify({ on }) }),
  muteConversation: (id, hours) => req(`/conversations/${id}/mute`, { method: 'POST', body: JSON.stringify({ hours }) }),
  blockConversation: (id, on) => req(`/conversations/${id}/block`, { method: 'POST', body: JSON.stringify({ on }) }),
  deleteConversation: (id) => req(`/conversations/${id}`, { method: 'DELETE' }),
  conversation: (id) => req(`/conversations/${id}`),
  olderMessages: (id, before) => req(`/conversations/${id}/messages?before=${before}`),
  send: (id, body, replyTo = null) => req(`/conversations/${id}/messages`, { method: 'POST', body: JSON.stringify({ body, replyTo }) }),
  takeover: (id) => req(`/conversations/${id}/takeover`, { method: 'POST' }),
  handback: (id) => req(`/conversations/${id}/handback`, { method: 'POST' }),
  acceptHandoff: (id) => req(`/conversations/${id}/accept`, { method: 'POST' }),
  rejectHandoff: (id) => req(`/conversations/${id}/reject`, { method: 'POST' }),
  templates: () => req('/templates'),
  syncTemplates: () => req('/templates/sync', { method: 'POST' }),
  sendTemplate: (id, name, params) =>
    req(`/conversations/${id}/template`, { method: 'POST', body: JSON.stringify({ name, params }) }),

  overview: () => req('/overview'),
  campaigns: () => req('/campaigns'),
  linkCampaignTopic: (id, topicId) => req(`/campaigns/${id}`, { method: 'PUT', body: JSON.stringify({ topicId }) }),
  getSettings: () => req('/settings'),
  saveSettings: (body) => req('/settings', { method: 'PUT', body: JSON.stringify(body) }),
  getProfile: () => req('/profile'),
  saveProfile: (body) => req('/profile', { method: 'PUT', body: JSON.stringify(body) }),
  importFaqs: (text, topicId = null) =>
    req('/faqs/import', { method: 'POST', body: JSON.stringify({ text, topicId }) }),
  runRefinement: () => req('/faqs/refine', { method: 'POST' }),
  proposals: (status = 'open') => req(`/faqs/proposals?status=${encodeURIComponent(status)}`),
  approveProposal: (id, body) =>
    req(`/faqs/proposals/${id}/approve`, { method: 'POST', body: JSON.stringify(body) }),
  dismissProposal: (id) => req(`/faqs/proposals/${id}/dismiss`, { method: 'POST' }),
  packs: () => req('/packs'),
  faqs: (pack = 'all') => req(`/faqs?pack=${encodeURIComponent(pack)}`),
  addFaq: (body) => req('/faqs', { method: 'POST', body: JSON.stringify(body) }),
  updateFaq: (id, body) => req(`/faqs/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteFaq: (id) => req(`/faqs/${id}`, { method: 'DELETE' }),
  reorderFaqs: (ids) => req('/faqs/reorder', { method: 'POST', body: JSON.stringify({ ids }) }),
  faqVersions: (id) => req(`/faqs/${id}/versions`),
  rollbackFaq: (versionId) => req(`/faqs/versions/${versionId}/rollback`, { method: 'POST' }),
  searchFaqs: (q) => req(`/faqs/search?q=${encodeURIComponent(q)}`),
  bulkFaqs: (ids, action) => req('/faqs/bulk', { method: 'POST', body: JSON.stringify({ ids, action }) }),
  simulate: (body) => req('/faqs/simulate', { method: 'POST', body: JSON.stringify(body) }),
  exportFaqs: () => req('/faqs/export'),
  topics: () => req('/topics'),
  addTopic: (body) => req('/topics', { method: 'POST', body: JSON.stringify(body) }),
  updateTopic: (id, body) => req(`/topics/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteTopic: (id) => req(`/topics/${id}`, { method: 'DELETE' }),
  agents: () => req('/agents'),
  addAgent: (email, name, password) =>
    req('/agents', { method: 'POST', body: JSON.stringify({ email, name, password }) }),
  deleteAgent: (id) => req(`/agents/${id}`, { method: 'DELETE' }),
  media: (topicId = null) => req(`/media${topicId ? `?topicId=${topicId}` : ''}`),
  deleteMedia: (id) => req(`/media/${id}`, { method: 'DELETE' }),
  sendMedia: (id, assetId, caption) =>
    req(`/conversations/${id}/media`, { method: 'POST', body: JSON.stringify({ assetId, caption }) }),
  audit: () => req('/audit'),
  createTemplate: (name, category, bodyText) =>
    req('/templates/create', { method: 'POST', body: JSON.stringify({ name, category, bodyText }) }),
  getVapidKey: () => req('/push/vapid-public-key'),
  pushSubscribe: (body) => req('/push/subscribe', { method: 'POST', body: JSON.stringify(body) }),
  pushUnsubscribe: (endpoint) => req('/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint }) }),
  pushStatus: () => req('/push/status'),
  pushTest: () => req('/push/test', { method: 'POST' }),
  notifications: () => req('/notifications'),
  markNotificationRead: (id) => req(`/notifications/${id}/read`, { method: 'POST' }),
  markAllNotificationsRead: () => req('/notifications/read-all', { method: 'POST' }),
  branding: () =>
    fetch('/api/branding')
      .then((r) => r.json())
      .then((d) => d.branding)
      .catch(() => null),
  mediaObjectUrl: async (messageId) => {
    const token = getToken();
    const res = await fetch(`/api/messages/${messageId}/media`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) {
      let msg = 'This file is no longer available. Meta only keeps attachments for about 30 days.';
      try { const j = await res.json(); if (j?.error) msg = j.error; } catch { /* body was not JSON */ }
      throw new Error(msg);
    }
    const blob = await res.blob();
    return { url: URL.createObjectURL(blob), size: blob.size, contentType: blob.type };
  },
  uploadMedia: async (file, topicId = null, description = '') => {
    const token = getToken();
    const fd = new FormData();
    fd.append('file', file);
    if (topicId) fd.append('topicId', String(topicId));
    if (description) fd.append('description', description);
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
