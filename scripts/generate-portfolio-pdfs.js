#!/usr/bin/env node
// Writes the dummy portfolio PDFs to disk for a quick look. To actually put
// them on WhatsApp (upload to Meta and attach to the right FAQ), run
// seed-portfolio-media.js instead - this script is just for previewing them.
//
// Usage: node scripts/generate-portfolio-pdfs.js [outputDir]

import fs from 'node:fs';
import path from 'node:path';
import { buildPdf, docs } from './lib/portfolio-content.js';

const outDir = process.argv[2] || 'portfolio-pdfs';
fs.mkdirSync(outDir, { recursive: true });

for (const [slug, doc] of Object.entries(docs)) {
  const pdf = buildPdf(doc.blocks);
  const file = path.join(outDir, `${slug}-portfolio.pdf`);
  fs.writeFileSync(file, pdf);
  console.log(`wrote ${file} (${pdf.length} bytes)`);
}
