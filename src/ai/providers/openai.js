import OpenAI from 'openai';
import { AI_TEMPERATURE, AI_MAX_OUTPUT_TOKENS } from '../tuning.js';

// OpenAI chat completions. complete() takes the shared message shape [{ role, content }] and returns the raw text, throwing on any error so the AiClient can fail over to another provider.
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
      temperature: AI_TEMPERATURE,
      max_tokens: AI_MAX_OUTPUT_TOKENS,
    };
    if (options.json) body.response_format = { type: 'json_object' };

    const res = await this.client.chat.completions.create(body, { timeout: this.timeoutMs });
    const choice = res.choices[0];
    if (choice?.finish_reason === 'length') {
      throw new Error('OpenAI response was truncated by the output token limit');
    }
    return choice?.message?.content?.trim() ?? '';
  }
}
