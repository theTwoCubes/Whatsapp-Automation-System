// Loads a text file (FAQ or notes) into a Topic through the ingestion pipeline.
// Creates the topic first if it does not exist. Usage:
//
//   node scripts/load-topic.js <slug> <name> <file>
//
//   node scripts/load-topic.js logo_design "Logo Design" temp/logo_designing_faq.txt

import { readFile } from 'node:fs/promises';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db/pool.js';
import { AiClient } from '../src/ai/client.js';
import { EmbeddingClient } from '../src/ai/embeddings.js';
import { upsertTopic } from '../src/knowledge/topics.js';
import { ingestText } from '../src/knowledge/ingestion.js';

const [, , slug, name, file] = process.argv;
if (!slug || !name || !file) {
  console.error('usage: node scripts/load-topic.js <slug> <name> <file>');
  process.exit(1);
}

const config = loadConfig();
const pool = createPool(config);
const log = {
  info() {}, warn() {}, error(...a) { console.error(...a); }, debug() {}, child() { return this; },
};
const ai = new AiClient(config, log);
const embeddings = new EmbeddingClient(config, log);

try {
  const text = await readFile(file, 'utf8');
  const topic = await upsertTopic(pool, { slug, name });
  console.log(`topic ${topic.slug} id ${topic.id}`);
  const res = await ingestText(pool, ai, embeddings, text, { scope: 'topic', topicId: topic.id });
  console.log(`added ${res.added}, skipped ${res.skipped}`);
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
