import OpenAI from 'openai';

// OpenAI chat completions. complete() takes the shared message shape
// [{ role, content }] and returns the raw text, throwing on any error so the
// AiClient can fail over to another provider.
export class OpenAIProvider {
  constructor(apiKey, model) {
    this.name = 'openai';
    this.client = new OpenAI({ apiKey });
    this.model = model;
    this.timeoutMs = 20000;
  }

  async complete(messages, options = {}) {
    const body = {
      model: options.model ?? this.model,
      messages,
      temperature: 0.6,
      // Was 400 - too tight for a longer reply or a non-Latin script, which
      // truncated the JSON mid-string with no error.
      max_tokens: 1024,
    };
    if (options.json) body.response_format = { type: 'json_object' };

    const res = await this.client.chat.completions.create(body, { timeout: this.timeoutMs });
    const choice = res.choices[0];
    // Throwing on a truncated response is what lets AiClient fail over to
    // the other provider instead of silently treating garbage JSON as a
    // deliberate handoff.
    if (choice?.finish_reason === 'length') {
      throw new Error('OpenAI response was truncated by the output token limit');
    }
    return choice?.message?.content?.trim() ?? '';
  }
}
