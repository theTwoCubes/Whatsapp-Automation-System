#!/usr/bin/env node
// Uploads the portfolio PDFs to Meta and files each one under its service, so
// the bot can pick it from the media catalog the moment a lead asks for
// samples - no FAQ wiring involved, the AI reasons from the description.
//
// Safe to re-run: it removes any asset with the same filename first, so
// repeated runs (including after regenerating lib/portfolio-content.js with
// real client-supplied content) never leave duplicate or stale files behind
// for the AI to pick from.
//
// Usage (on the server, with the same .env the app uses):
//   node scripts/seed-portfolio-media.js

import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db/pool.js';
import { MetaClient } from '../src/meta/client.js';
import { addMediaAsset } from '../src/db/repo.js';
import { getTopicBySlug } from '../src/knowledge/topics.js';
import { buildPdf, docs } from './lib/portfolio-content.js';

const log = {
  info(...a) { console.log(...a); },
  warn(...a) { console.warn(...a); },
  error(...a) { console.error(...a); },
  debug() {},
  child() { return this; },
};

const config = loadConfig();
const pool = createPool(config);
const meta = new MetaClient(config, log);

async function run() {
  for (const [slug, doc] of Object.entries(docs)) {
    const topic = doc.topicSlug ? await getTopicBySlug(pool, doc.topicSlug) : null;
    if (doc.topicSlug && !topic) {
      console.warn(`  skip: topic "${doc.topicSlug}" not found - run scripts/seed-faqs.js first`);
      continue;
    }

    const filename = `${slug}-portfolio.pdf`;
    await pool.query('delete from media_assets where filename = $1', [filename]);

    const pdf = buildPdf(doc.blocks);
    const metaMediaId = await meta.uploadMedia(pdf, 'application/pdf', filename);
    const assetId = await addMediaAsset(pool, {
      metaMediaId,
      filename,
      mimeType: 'application/pdf',
      kind: 'document',
      topicId: topic ? topic.id : null,
      description: doc.description,
    });
    console.log(`  ok: ${slug} -> media ${assetId}${topic ? ` (${topic.name})` : ' (general)'}`);
  }
}

run()
  .catch((err) => { console.error('failed:', err.message); process.exitCode = 1; })
  .finally(() => pool.end());
