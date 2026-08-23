import OpenAI from 'openai';

// Wraps the OpenAI chat API. The only place we call OpenAI from, so swapping
// the model or provider is a one file change. When no api key is configured the
// client is disabled and complete() throws, which the caller treats as a reason
// to fall back to a canned reply.
export class AiClient {
  constructor(config, log) {
    this.log = log;
    this.model = config.openaiModel;
    this.enabled = Boolean(config.openaiApiKey);
    this.client = this.enabled ? new OpenAI({ apiKey: config.openaiApiKey }) : null;
    this.timeoutMs = 20000;
  }

  async complete(messages, options = {}) {
    if (!this.enabled) {
      throw new Error('AI disabled: OPENAI_API_KEY is not set');
    }
    const body = {
      model: options.model ?? this.model,
      messages,
      temperature: 0.6,
      max_tokens: 400,
    };
    if (options.json) {
      body.response_format = { type: 'json_object' };
    }
    const res = await this.client.chat.completions.create(body, { timeout: this.timeoutMs });
    return res.choices[0]?.message?.content?.trim() ?? '';
  }
}
