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

// Reads the role claim baked into the JWT so the shell can hide admin-only
// nav from an ordinary agent. The server is still the source of truth: it
// returns 403 on any admin route regardless of what the JWT claims.
export function getAgentRole() {
  try {
    const token = getToken();
    if (!token) return null;
    const payload = JSON.parse(atob(token.split('.')[1]));
    return payload.role === 'admin' ? 'admin' : 'agent';
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
  if (!res.ok) {
    // Attach the server's code and status so callers can react to specific
    // conditions (e.g. an assignment conflict prompts a confirm dialog).
    const err = new Error(data.error || 'request failed');
    err.status = res.status;
    err.code = data.code;
    err.data = data;
    throw err;
  }
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
  clearChat: (id) => req(`/conversations/${id}/clear`, { method: 'POST' }),
  conversation: (id) => req(`/conversations/${id}`),
  updateContact: (id, fields) => req(`/conversations/${id}/contact`, { method: 'PUT', body: JSON.stringify(fields) }),
  notes: (id) => req(`/conversations/${id}/notes`),
  addNote: (id, note) => req(`/conversations/${id}/notes`, { method: 'POST', body: JSON.stringify({ note }) }),
  deleteNote: (id, noteId) => req(`/conversations/${id}/notes/${noteId}`, { method: 'DELETE' }),
  tags: () => req('/tags'),
  createTag: (name, color) => req('/tags', { method: 'POST', body: JSON.stringify({ name, color }) }),
  deleteTag: (tagId) => req(`/tags/${tagId}`, { method: 'DELETE' }),
  tagConversation: (id, tagId) => req(`/conversations/${id}/tags`, { method: 'POST', body: JSON.stringify({ tagId }) }),
  untagConversation: (id, tagId) => req(`/conversations/${id}/tags/${tagId}`, { method: 'DELETE' }),
  bulkSend: async (file, templateName, topicId) => {
    const token = getToken();
    const fd = new FormData();
    fd.append('file', file);
    fd.append('templateName', templateName);
    if (topicId) fd.append('topicId', String(topicId));
    const res = await fetch('/api/bulk-send', {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: fd,
    });
    if (res.status === 401) {
      clearToken();
      throw new Error('unauthorized');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'bulk send failed');
    return data;
  },
  bulkSendBatches: () => req('/bulk-send/batches'),
  bulkSendProgress: (batchId) => req(`/bulk-send/${batchId}`),
  olderMessages: (id, before) => req(`/conversations/${id}/messages?before=${before}`),
  send: (id, body, replyTo = null) => req(`/conversations/${id}/messages`, { method: 'POST', body: JSON.stringify({ body, replyTo }) }),
  sendReaction: (id, wamid, emoji) => req(`/conversations/${id}/reactions`, { method: 'POST', body: JSON.stringify({ wamid, emoji }) }),
  takeover: (id, override = false) =>
    req(`/conversations/${id}/takeover`, { method: 'POST', body: JSON.stringify({ override }) }),
  handback: (id) => req(`/conversations/${id}/handback`, { method: 'POST' }),
  acceptHandoff: (id) => req(`/conversations/${id}/accept`, { method: 'POST' }),
  rejectHandoff: (id) => req(`/conversations/${id}/reject`, { method: 'POST' }),
  templates: () => req('/templates'),
  syncTemplates: () => req('/templates/sync', { method: 'POST' }),
  sendTemplate: (id, name, params) =>
    req(`/conversations/${id}/template`, { method: 'POST', body: JSON.stringify({ name, params }) }),

  overview: () => req('/overview'),
  leads: ({ topicId = null, state = null, search = null } = {}) => {
    const params = new URLSearchParams();
    if (topicId != null) params.set('topicId', topicId);
    if (state) params.set('state', state);
    if (search) params.set('search', search);
    const qs = params.toString();
    return req(`/leads${qs ? `?${qs}` : ''}`);
  },
  dismissLead: (contactId) => req(`/leads/${contactId}/dismiss`, { method: 'POST' }),
  campaigns: () => req('/campaigns'),
  linkCampaignTopic: (id, topicId) => req(`/campaigns/${id}`, { method: 'PUT', body: JSON.stringify({ topicId }) }),
  getSettings: () => req('/settings'),
  saveSettings: (body) => req('/settings', { method: 'PUT', body: JSON.stringify(body) }),
  getProfile: () => req('/profile'),
  saveProfile: (body) => req('/profile', { method: 'PUT', body: JSON.stringify(body) }),
  importFaqs: (text, topicId = null) =>
    req('/faqs/import', { method: 'POST', body: JSON.stringify({ text, topicId }) }),
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
  topics: () => req('/topics'),
  addTopic: (body) => req('/topics', { method: 'POST', body: JSON.stringify(body) }),
  updateTopic: (id, body) => req(`/topics/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteTopic: (id) => req(`/topics/${id}`, { method: 'DELETE' }),
  agents: () => req('/agents'),
  addAgent: (email, name, password, role) =>
    req('/agents', { method: 'POST', body: JSON.stringify({ email, name, password, role }) }),
  deleteAgent: (id) => req(`/agents/${id}`, { method: 'DELETE' }),
  aiSettings: () => req('/ai-settings'),
  saveAiSettings: (body) => req('/ai-settings', { method: 'PUT', body: JSON.stringify(body) }),
  media: (topicId = null) => req(`/media${topicId ? `?topicId=${topicId}` : ''}`),
  deleteMedia: (id) => req(`/media/${id}`, { method: 'DELETE' }),
  downloadMedia: async (id) => {
    const token = getToken();
    const res = await fetch(`/api/media/${id}/download`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (res.status === 401) {
      clearToken();
      throw new Error('unauthorized');
    }
    if (!res.ok) {
      let msg = 'Download failed';
      try { const j = await res.json(); if (j?.error) msg = j.error; } catch { /* body was not JSON */ }
      throw new Error(msg);
    }
    return res.blob();
  },
  sendMedia: (id, assetId, caption) =>
    req(`/conversations/${id}/media`, { method: 'POST', body: JSON.stringify({ assetId, caption }) }),
  paymentLinks: (topicId = null) => req(`/payment-links${topicId ? `?topicId=${topicId}` : ''}`),
  addPaymentLink: (body) => req('/payment-links', { method: 'POST', body: JSON.stringify(body) }),
  updatePaymentLink: (id, body) => req(`/payment-links/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deletePaymentLink: (id) => req(`/payment-links/${id}`, { method: 'DELETE' }),
  audit: () => req('/audit'),
  getVapidKey: () => req('/push/vapid-public-key'),
  pushSubscribe: (body) => req('/push/subscribe', { method: 'POST', body: JSON.stringify(body) }),
  pushUnsubscribe: (endpoint) => req('/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint }) }),
  pushStatus: () => req('/push/status'),
  pushTest: () => req('/push/test', { method: 'POST' }),
  wsTicket: () => req('/ws-ticket', { method: 'POST' }),
  ops: () => req('/admin/ops'),
  notifications: () => req('/notifications'),
  markNotificationRead: (id) => req(`/notifications/${id}/read`, { method: 'POST' }),
  markAllNotificationsRead: () => req('/notifications/read-all', { method: 'POST' }),
  deleteNotification: (id) => req(`/notifications/${id}`, { method: 'DELETE' }),
  deleteAllNotifications: () => req('/notifications', { method: 'DELETE' }),
  toggleSaveNotification: (id) => req(`/notifications/${id}/save`, { method: 'POST' }),
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
  exportContacts: async ({ topicId = null, state = null, search = null } = {}) => {
    const token = getToken();
    const params = new URLSearchParams();
    if (topicId != null) params.set('topicId', topicId);
    if (state) params.set('state', state);
    if (search) params.set('search', search);
    const qs = params.toString();
    const res = await fetch(`/api/contacts/export${qs ? `?${qs}` : ''}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (res.status === 401) {
      clearToken();
      throw new Error('unauthorized');
    }
    if (!res.ok) throw new Error('export failed');
    return res.blob();
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
