import { OpenAIProvider } from './providers/openai.js';
import { GeminiProvider } from './providers/gemini.js';

// Talks to whichever AI providers are configured. It tries the primary provider
// first (set by AI_PROVIDER), and if that errors it fails over to the other. If
// every provider errors, or none is configured, complete() throws and the
// caller falls back to a canned message.
export class AiClient {
  constructor(config, log, providers) {
    this.log = log;
    this.providers = providers ?? buildProviders(config);
    this.order = orderProviders(config.aiProvider, this.providers);
    this.enabled = this.order.length > 0;
  }

  async complete(messages, options = {}) {
    if (!this.enabled) {
      throw new Error('AI disabled: no provider key configured');
    }
    let lastError;
    for (const name of this.order) {
      try {
        return await this.providers[name].complete(messages, options);
      } catch (err) {
        lastError = err;
        this.log.warn({ provider: name, err: err.message }, 'ai provider failed, trying the next one');
      }
    }
    throw lastError ?? new Error('all ai providers failed');
  }
}

export function buildProviders(config) {
  const providers = {};
  if (config.openaiApiKey) providers.openai = new OpenAIProvider(config.openaiApiKey, config.openaiModel);
  if (config.geminiApiKey) providers.gemini = new GeminiProvider(config.geminiApiKey, config.geminiModel);
  return providers;
}

// Primary provider first, then any others that are configured.
export function orderProviders(primary, providers) {
  const available = Object.keys(providers);
  const order = [];
  if (primary && available.includes(primary)) order.push(primary);
  for (const name of available) {
    if (!order.includes(name)) order.push(name);
  }
  return order;
}
