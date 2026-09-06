#!/usr/bin/env node
// Uploads the portfolio PDFs to Meta and attaches each one to the matching
// "can I see samples" FAQ, so the bot can send it the moment someone asks -
// no manual upload through the console needed.
//
// Safe to re-run: it always uploads a fresh copy and repoints the FAQ at the
// new asset, so once the client sends real portfolio files, regenerate
// lib/portfolio-content.js content (or point this at different PDFs) and
// run this again to swap them in.
//
// Usage (on the server, with the same .env the app uses):
//   node scripts/seed-portfolio-media.js

import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db/pool.js';
import { MetaClient } from '../src/meta/client.js';
import { addMediaAsset } from '../src/db/repo.js';
import { getTopicBySlug } from '../src/knowledge/topics.js';
import { listFaqs, updateFaq } from '../src/knowledge/faqs.js';
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

    const faqs = await listFaqs(pool, { pack: topic ? topic.id : 'base' });
    const faq = faqs.find((f) => f.question.trim() === doc.faqQuestion);
    if (!faq) {
      console.warn(`  skip: FAQ "${doc.faqQuestion}" not found for "${slug}" - run scripts/seed-faqs.js first`);
      continue;
    }

    const pdf = buildPdf(doc.blocks);
    const filename = `${slug}-portfolio.pdf`;
    const metaMediaId = await meta.uploadMedia(pdf, 'application/pdf', filename);
    const assetId = await addMediaAsset(pool, {
      metaMediaId,
      filename,
      mimeType: 'application/pdf',
      kind: 'document',
      topicId: topic ? topic.id : null,
      description: doc.title,
    });
    await updateFaq(pool, faq.id, { mediaAssetId: assetId }, 'seed-portfolio-media');
    console.log(`  ok: ${slug} -> media ${assetId} attached to faq ${faq.id}`);
  }
}

run()
  .catch((err) => { console.error('failed:', err.message); process.exitCode = 1; })
  .finally(() => pool.end());
