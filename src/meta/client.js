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
