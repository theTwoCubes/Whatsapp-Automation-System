#!/usr/bin/env node
// Idempotent loader for the FAQ packs in faq/packs/*.md.
//
// Each file becomes one topic (base is topic_id = null). Every Q/A pair
// becomes one faq row. Re-running the script wipes and re-inserts the rows
// for that pack (so edits to a file always win); it never touches other packs.
//
// Usage on the VPS (from the repo root, with the same DATABASE_URL the app
// uses):
//   node scripts/seed-faqs.js
//
// To load only one pack:
//   node scripts/seed-faqs.js base
//   node scripts/seed-faqs.js logo-design

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKS_DIR = path.join(__dirname, '..', 'faq', 'packs');

// slug -> service metadata. Keys must match the .md filenames without the
// extension; a file with no entry here is skipped, and an entry with no file
// is reported and ignored. Replace these with your own services.
//
// "description" is shown to the AI so it can tell similarly named services
// apart - write it to answer "how is this different from the one next to it",
// because that is the question it is actually used for.
//
// "keywords" are a convenience for the console's own filtering. They do not
// decide which service a conversation is filed under: that is the AI's call,
// held to the rules in src/ai/reconcile.js. Word matching used to decide it
// and was the single worst source of mis-filed leads, because two services
// with overlapping names scored equally and the tie broke arbitrarily.
//
// Drip follow ups are not managed here - configure the general sequence and
// any per-service overrides from the Follow-ups page in the console once
// templates are approved and synced from Meta.
const PACKS = {
  base: { name: null, description: null, keywords: null },
  'logo-design': {
    name: 'Logo Design',
    description: 'Logo and brand identity package, fixed fee.',
    keywords: 'logo, branding, identity, brand mark, wordmark',
  },
};

function parsePack(text) {
  // Splits the file into Q/A pairs. Recognises `Q:` and `A:` prefixes.
  // Flag lines immediately before a Q, in any order, apply to that answer:
  //   !verbatim  quote this answer word for word
  //   !pinned    never drop this answer, even if the prompt budget is tight
  const lines = text.split('\n');
  const items = [];
  let current = null;
  let mode = null; // 'q' or 'a'
  let verbatimNext = false;
  let pinnedNext = false;

  const flush = () => {
    if (current && current.question.trim() && current.answer.trim()) {
      items.push({
        question: current.question.trim(),
        answer: current.answer.trim(),
        verbatim: current.verbatim,
        pinned: current.pinned,
      });
    }
    current = null;
    mode = null;
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (/^!verbatim\s*$/i.test(line)) { verbatimNext = true; continue; }
    if (/^!pinned\s*$/i.test(line)) { pinnedNext = true; continue; }
    if (/^#\s/.test(line)) { flush(); continue; }
    const qm = line.match(/^Q:\s?(.*)$/);
    const am = line.match(/^A:\s?(.*)$/);
    if (qm) {
      flush();
      current = { question: qm[1], answer: '', verbatim: verbatimNext, pinned: pinnedNext };
      verbatimNext = false;
      pinnedNext = false;
      mode = 'q';
      continue;
    }
    if (am) {
      if (!current) continue;
      current.answer = am[1];
      mode = 'a';
      continue;
    }
    if (!current) continue;
    if (mode === 'q') current.question += (current.question ? ' ' : '') + line;
    else if (mode === 'a') current.answer += (current.answer ? '\n' : '') + line;
  }
  flush();
  return items;
}

async function upsertTopic(client, slug, meta) {
  if (slug === 'base') return null;
  const existing = await client.query('select id from topics where slug = $1', [slug]);
  if (existing.rows[0]) {
    await client.query(
      `update topics set name = $2, description = $3, keywords = $4, active = true, updated_at = now()
       where id = $1`,
      [existing.rows[0].id, meta.name, meta.description, meta.keywords],
    );
    return existing.rows[0].id;
  }
  const inserted = await client.query(
    `insert into topics (slug, name, description, keywords, active)
     values ($1, $2, $3, $4, true) returning id`,
    [slug, meta.name, meta.description, meta.keywords],
  );
  return inserted.rows[0].id;
}

async function replaceFaqs(client, topicId, items) {
  // Wipe the existing rows for this pack, then re-insert. faq_versions rows
  // cascade with the delete, so history in that table only reflects the live
  // ids. That's fine for a seed script - versioning is for in-app edits.
  const where = topicId == null ? 'topic_id is null' : 'topic_id = $1';
  const params = topicId == null ? [] : [topicId];
  await client.query(`delete from faqs where ${where}`, params);
  let position = 1;
  for (const item of items) {
    const inserted = await client.query(
      `insert into faqs (topic_id, question, answer, verbatim, pinned, active, source, position)
       values ($1, $2, $3, $4, $5, true, 'seed', $6) returning id`,
      [topicId, item.question, item.answer, item.verbatim, item.pinned, position++],
    );
    await client.query(
      `insert into faq_versions (faq_id, question, answer, verbatim, actor)
       values ($1, $2, $3, $4, 'seed-script')`,
      [inserted.rows[0].id, item.question, item.answer, item.verbatim],
    );
  }
}

async function main() {
  const only = process.argv.slice(2);
  const targets = only.length ? only : Object.keys(PACKS);

  const missingUrl = !process.env.DATABASE_URL;
  if (missingUrl) {
    console.error('DATABASE_URL is not set. Add it to .env or export it before running.');
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query('begin');
    for (const slug of targets) {
      const meta = PACKS[slug];
      if (!meta) { console.warn(`  skip: no metadata for pack "${slug}"`); continue; }
      const filePath = path.join(PACKS_DIR, `${slug}.md`);
      if (!fs.existsSync(filePath)) { console.warn(`  skip: ${filePath} not found`); continue; }
      const text = fs.readFileSync(filePath, 'utf8');
      const items = parsePack(text);
      const topicId = await upsertTopic(client, slug, meta);
      await replaceFaqs(client, topicId, items);
      const label = slug === 'base' ? 'base (topic_id=null)' : `${slug} (topic_id=${topicId})`;
      console.log(`  ok:   ${label} - ${items.length} FAQs`);
    }
    await client.query('commit');
    console.log('done.');
  } catch (err) {
    await client.query('rollback');
    console.error('failed, rolled back:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
