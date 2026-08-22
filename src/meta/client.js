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

  // Sends a plain text message and returns the message id Meta assigns.
  async sendText(to, body) {
    const url = `${this.baseUrl}/${this.config.phoneNumberId}/messages`;
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { preview_url: false, body },
    };

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
      this.log.error({ to, err }, 'sendText request failed before a response');
      throw new MetaApiError(err.message);
    }

    const data = await res.json();

    if (!res.ok || data.error) {
      const err = data.error;
      this.log.error({ to, status: res.status, error: err }, 'Cloud API rejected sendText');
      throw new MetaApiError(err?.message ?? `Cloud API returned HTTP ${res.status}`, err?.code);
    }

    const wamid = data.messages?.[0]?.id ?? '';
    this.log.info({ to, wamid }, 'sendText delivered to Cloud API');
    return wamid;
  }
}
