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

  // Rebuilds providers and ordering in place, so a provider or key changed
  // from the console takes effect on the very next call, without a restart.
  reconfigure(config) {
    this.providers = buildProviders(config);
    this.order = orderProviders(config.aiProvider, this.providers);
    this.enabled = this.order.length > 0;
  }

  // Returns { text, provider, failedProviders } - provider is whichever one
  // actually answered, and failedProviders lists any that were tried and
  // errored first (empty when the primary just worked). Callers that only
  // need the text can destructure { text }; the simulator surfaces the rest
  // so a silent failover isn't invisible to whoever is looking at it.
  async complete(messages, options = {}) {
    if (!this.enabled) {
      throw new Error('AI disabled: no provider key configured');
    }
    // Snapshotted once up front - reconfigure() can swap this.providers/order
    // out from under a call that's already in flight (an admin changing the
    // AI provider/key mid-request), and reading the new object partway
    // through this loop would look up a provider name that may not exist in
    // it, which used to log as a misleading "provider failure".
    const providers = this.providers;
    const order = this.order;
    const timeoutMs = options.timeoutMs ?? 25000;
    const failedProviders = [];
    let lastError;
    for (const name of order) {
      try {
        const text = await Promise.race([
          providers[name].complete(messages, options),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`ai timeout after ${timeoutMs}ms`)), timeoutMs),
          ),
        ]);
        return { text, provider: name, failedProviders };
      } catch (err) {
        lastError = err;
        failedProviders.push({ provider: name, error: err.message });
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
