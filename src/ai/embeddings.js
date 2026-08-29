import OpenAI from 'openai';

// Text embedding client. Uses OpenAI text-embedding-3-small at 1536 dimensions,
// which matches the vector column on media_assets. Answers are not embedded,
// the model is handed whole packs as text, so this is only used to match a
// media description to what a lead asked about. Switching model or dimension
// later means re-embedding, since vector spaces are not compatible.

const DEFAULT_MODEL = 'text-embedding-3-small';
const DIMENSIONS = 1536;
const BATCH_SIZE = 96;

export class EmbeddingClient {
  constructor(config, log) {
    this.log = log;
    this.model = (config.embeddingModel || DEFAULT_MODEL).trim();
    this.dimensions = DIMENSIONS;
    this.enabled = Boolean(config.openaiApiKey);
    this.client = this.enabled ? new OpenAI({ apiKey: config.openaiApiKey }) : null;
    this.timeoutMs = 15000;
  }

  async embed(text) {
    if (!this.enabled) throw new Error('embeddings disabled: OPENAI_API_KEY is not set');
    const trimmed = (text || '').trim();
    if (!trimmed) return null;
    const res = await this.client.embeddings.create(
      { model: this.model, input: trimmed },
      { timeout: this.timeoutMs },
    );
    return res.data[0]?.embedding ?? null;
  }

  async embedBatch(texts) {
    if (!this.enabled) throw new Error('embeddings disabled: OPENAI_API_KEY is not set');
    const inputs = texts.map((t) => (t || '').trim());
    const out = [];
    for (let i = 0; i < inputs.length; i += BATCH_SIZE) {
      const chunk = inputs.slice(i, i + BATCH_SIZE);
      const nonEmpty = chunk.map((t, idx) => ({ t, idx })).filter((x) => x.t);
      if (nonEmpty.length === 0) {
        for (let j = 0; j < chunk.length; j += 1) out.push(null);
        continue;
      }
      const res = await this.client.embeddings.create(
        { model: this.model, input: nonEmpty.map((x) => x.t) },
        { timeout: this.timeoutMs },
      );
      const placed = new Array(chunk.length).fill(null);
      nonEmpty.forEach((x, i2) => {
        placed[x.idx] = res.data[i2]?.embedding ?? null;
      });
      for (const v of placed) out.push(v);
    }
    return out;
  }
}

// Formats a vector array as a Postgres vector literal.
export function toPgVector(embedding) {
  if (!embedding) return null;
  return `[${embedding.join(',')}]`;
}
