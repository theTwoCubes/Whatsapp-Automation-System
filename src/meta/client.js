// Wraps the Meta Graph API. Everything that talks to WhatsApp goes through
// here so a token change or version bump only touches one file.

export class MetaApiError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'MetaApiError';
    this.code = code;
  }
}

export class MetaClient {
  constructor(config, log) {
    this.config = config;
    this.log = log;
    this.baseUrl = `https://graph.facebook.com/${config.graphApiVersion}`;
    this.timeoutMs = 10000;
  }

  // Sends a plain text message. Only works inside the 24 hour service window.
  async sendText(to, body) {
    return this.send(to, {
      type: 'text',
      text: { preview_url: false, body },
    });
  }

  // Sends an approved template. This is how we reach a lead outside the 24 hour
  // window, for the drip follow ups.
  async sendTemplate(to, name, language = 'en', components) {
    const template = { name, language: { code: language } };
    if (components) template.components = components;
    return this.send(to, { type: 'template', template });
  }

  // Pulls the message templates and their approval status so the console can
  // show what is actually allowed to be sent, especially outside the 24 hour
  // window. Returns a flat list with the body text pulled out.
  async fetchTemplates() {
    const url = `${this.baseUrl}/${this.config.wabaId}/message_templates?fields=name,status,category,language,components&limit=200`;
    let res;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${this.config.accessToken}` },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new MetaApiError(err.message);
    }
    const data = await res.json();
    if (!res.ok || data.error) {
      throw new MetaApiError(data.error?.message ?? `Cloud API returned HTTP ${res.status}`, data.error?.code);
    }
    return (data.data ?? []).map((t) => ({
      name: t.name,
      language: t.language,
      category: t.category,
      status: t.status,
      body: (t.components ?? []).find((c) => c.type === 'BODY')?.text ?? null,
    }));
  }

  // Reads the WhatsApp business profile so the client can manage it from the
  // console instead of opening Meta.
  async getBusinessProfile() {
    const fields = 'about,address,description,email,profile_picture_url,websites,vertical';
    const url = `${this.baseUrl}/${this.config.phoneNumberId}/whatsapp_business_profile?fields=${fields}`;
    const data = await this.get(url);
    return data.data?.[0] ?? {};
  }

  async updateBusinessProfile(fields) {
    const url = `${this.baseUrl}/${this.config.phoneNumberId}/whatsapp_business_profile`;
    return this.postJson(url, { messaging_product: 'whatsapp', ...fields });
  }

  // Uploads a file to Meta and returns its media id, which can then be sent to a
  // lead. Media ids are reusable for a while.
  async uploadMedia(buffer, mimeType, filename) {
    const url = `${this.baseUrl}/${this.config.phoneNumberId}/media`;
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('file', new Blob([buffer], { type: mimeType }), filename || 'file');

    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.config.accessToken}` },
        body: form,
        signal: AbortSignal.timeout(30000),
      });
    } catch (err) {
      throw new MetaApiError(err.message);
    }
    const data = await res.json();
    if (!res.ok || data.error) {
      throw new MetaApiError(data.error?.message ?? `Cloud API returned HTTP ${res.status}`, data.error?.code);
    }
    return data.id;
  }

  // Sends an image or document to a lead by media id. Only works inside the 24
  // hour window, same as a text message.
  async sendMedia(to, kind, { id, link, caption, filename } = {}) {
    const media = {};
    if (id) media.id = id;
    if (link) media.link = link;
    if (caption) media.caption = caption;
    if (kind === 'document' && filename) media.filename = filename;
    return this.send(to, { type: kind, [kind]: media });
  }

  // Marks an inbound message as read so the customer sees blue ticks.
  async markRead(wamid) {
    const url = `${this.baseUrl}/${this.config.phoneNumberId}/messages`;
    return this.postJson(url, {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: wamid,
    });
  }

  // Blocks a wa_id at WhatsApp so the number can no longer message the
  // business. Best effort: if the API rejects it (e.g. the contact is outside
  // the block-eligible window) we still keep our local blocked flag so the bot
  // stays quiet, which is the behaviour the client actually cares about.
  async blockUser(waId) {
    const url = `${this.baseUrl}/${this.config.phoneNumberId}/block_users`;
    return this.postJson(url, {
      messaging_product: 'whatsapp',
      block_users: [{ user: waId }],
    });
  }

  async unblockUser(waId) {
    const url = `${this.baseUrl}/${this.config.phoneNumberId}/block_users`;
    let res;
    try {
      res = await fetch(url, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${this.config.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', block_users: [{ user: waId }] }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new MetaApiError(err.message);
    }
    const data = await res.json();
    if (!res.ok || data.error) {
      throw new MetaApiError(data.error?.message ?? `Cloud API returned HTTP ${res.status}`, data.error?.code);
    }
    return data;
  }

  async get(url) {
    let res;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${this.config.accessToken}` },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new MetaApiError(err.message);
    }
    const data = await res.json();
    if (!res.ok || data.error) {
      throw new MetaApiError(data.error?.message ?? `Cloud API returned HTTP ${res.status}`, data.error?.code);
    }
    return data;
  }

  async postJson(url, payload) {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.config.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new MetaApiError(err.message);
    }
    const data = await res.json();
    if (!res.ok || data.error) {
      throw new MetaApiError(data.error?.message ?? `Cloud API returned HTTP ${res.status}`, data.error?.code);
    }
    return data;
  }

  // Creates a message template so the client can author templates from the
  // console. It still has to be approved by Meta before it can be sent.
  async createTemplate({ name, category, language, bodyText }) {
    const url = `${this.baseUrl}/${this.config.wabaId}/message_templates`;
    return this.postJson(url, {
      name,
      category: category || 'UTILITY',
      language: language || 'en',
      components: [{ type: 'BODY', text: bodyText }],
    });
  }

  // Resolves the short lived download url for a media id, used to view media a
  // lead has sent.
  async getMediaUrl(mediaId) {
    const data = await this.get(`${this.baseUrl}/${mediaId}`);
    return data.url;
  }

  // Downloads media bytes from a media url. The url needs the same bearer token.
  async downloadMedia(mediaUrl) {
    let res;
    try {
      res = await fetch(mediaUrl, {
        headers: { Authorization: `Bearer ${this.config.accessToken}` },
        signal: AbortSignal.timeout(30000),
      });
    } catch (err) {
      throw new MetaApiError(err.message);
    }
    if (!res.ok) throw new MetaApiError(`media download failed with HTTP ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    return { buffer, contentType: res.headers.get('content-type') || 'application/octet-stream' };
  }

  async send(to, content) {
    const url = `${this.baseUrl}/${this.config.phoneNumberId}/messages`;
    const payload = { messaging_product: 'whatsapp', recipient_type: 'individual', to, ...content };

    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      this.log.error({ to, err }, 'send request failed before a response');
      throw new MetaApiError(err.message);
    }

    const data = await res.json();

    if (!res.ok || data.error) {
      const err = data.error;
      this.log.error({ to, status: res.status, error: err }, 'Cloud API rejected send');
      throw new MetaApiError(err?.message ?? `Cloud API returned HTTP ${res.status}`, err?.code);
    }

    const wamid = data.messages?.[0]?.id ?? '';
    this.log.info({ to, wamid, type: content.type }, 'message delivered to Cloud API');
    return wamid;
  }
}
