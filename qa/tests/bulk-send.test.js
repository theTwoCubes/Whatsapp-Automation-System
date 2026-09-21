import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyWebsocket from '@fastify/websocket';
import fastifyMultipart from '@fastify/multipart';
import ExcelJS from 'exceljs';

import { registerApi } from '../../src/routes/api.js';
import { runBulkSend } from '../../src/scheduler.js';
import { queueBulkSend, bulkSendBatchProgress, createAgent, recordInbound, reconcileContactWaId } from '../../src/db/repo.js';
import { upsertTopic } from '../../src/knowledge/topics.js';
import { hashPassword } from '../../src/auth.js';
import { setupPool, resetTables, FakeMeta, FakeAi, silentLog, testConfig } from './support/harness.js';

let pool;
const apiConfig = { ...testConfig, jwtSecret: 'test-secret' };
const noopRealtime = { emit() {}, add() {}, size: () => 0 };

before(async () => {
  pool = await setupPool();
});
after(async () => {
  await pool?.end();
});
beforeEach(async () => {
  await resetTables(pool);
  await pool.query('truncate agents restart identity cascade');
  await createAgent(pool, { email: 'a@b.com', name: 'A', passwordHash: hashPassword('secret'), role: 'admin' });
});

async function buildApp(meta) {
  const app = Fastify();
  await app.register(fastifyJwt, { secret: 'test-secret' });
  await app.register(fastifyWebsocket);
  await app.register(fastifyMultipart);
  registerApi(app, { pool, meta, ai: new FakeAi(), config: apiConfig, realtime: noopRealtime });
  await app.ready();
  return app;
}

async function tokenFor(app) {
  const res = await app.inject({ method: 'POST', url: '/api/login', payload: { email: 'a@b.com', password: 'secret' } });
  return res.json().token;
}

// Builds an in-memory .xlsx buffer the way a client's spreadsheet export
// would look: headers in row 1 (in whatever order the caller gives them),
// one lead per row after that.
async function buildLeadsXlsx(headers, rows) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Leads');
  sheet.addRow(headers);
  for (const row of rows) sheet.addRow(headers.map((h) => row[h] ?? ''));
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

// Fastify's inject() takes a raw body, so the multipart request is built the
// same way a browser would build one from a real <form>: via FormData, then
// read back out as a buffer with its boundary-bearing content-type header.
async function bulkSendRequest(app, token, { file, fields = {} }) {
  const fd = new FormData();
  if (file) fd.append('file', new Blob([file], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'leads.xlsx');
  for (const [key, value] of Object.entries(fields)) fd.append(key, String(value));
  const req = new Request('http://x/', { method: 'POST', body: fd });
  const body = Buffer.from(await req.arrayBuffer());
  return app.inject({
    method: 'POST',
    url: '/api/bulk-send',
    headers: { authorization: `Bearer ${token}`, 'content-type': req.headers.get('content-type') },
    payload: body,
  });
}

test('queued leads are sent their template a batch at a time and marked sent', async () => {
  const batchId = randomUUID();
  const queued = await queueBulkSend(pool, batchId, [
    { waId: '919000000001', name: 'Asha' },
    { waId: '919000000002', name: 'Bhavesh' },
  ], 'drip_day3');
  assert.equal(queued, 2);

  const meta = new FakeMeta();
  const processed = await runBulkSend({ pool, meta, config: testConfig, log: silentLog });
  assert.equal(processed, 2);
  assert.equal(meta.templates.length, 2);
  assert.deepEqual(meta.templates.map((t) => t.to).sort(), ['919000000001', '919000000002']);

  const progress = await bulkSendBatchProgress(pool, batchId);
  assert.equal(progress.total, 2);
  assert.equal(progress.byStatus.sent, 2);
});

test('a queued lead gets a real conversation, tagged with the chosen service', async () => {
  const topic = await upsertTopic(pool, { slug: 'logo_design', name: 'Logo Design' });
  const batchId = randomUUID();
  await queueBulkSend(pool, batchId, [
    { waId: '919000000003', name: 'Chetan', business: 'Chetan Traders', email: 'chetan@example.com', topicId: topic.id },
  ], 'drip_day3');

  await runBulkSend({ pool, meta: new FakeMeta(), config: testConfig, log: silentLog });

  const row = await pool.query(
    `select c.last_topic_id, ct.name, ct.business, ct.email
     from conversations c join contacts ct on ct.id = c.contact_id
     where ct.wa_id = '919000000003'`,
  );
  assert.equal(Number(row.rows[0].last_topic_id), Number(topic.id));
  assert.equal(row.rows[0].name, 'Chetan');
  assert.equal(row.rows[0].business, 'Chetan Traders');
  assert.equal(row.rows[0].email, 'chetan@example.com');
});

test('a send that throws before Meta confirms anything is marked failed with the error, not silently dropped', async () => {
  const batchId = randomUUID();
  await queueBulkSend(pool, batchId, [{ waId: '919000000004', name: 'Dev' }], 'drip_day3');

  const meta = new FakeMeta();
  meta.sendTemplate = async () => { throw new Error('template not approved'); };

  const processed = await runBulkSend({ pool, meta, config: testConfig, log: silentLog });
  assert.equal(processed, 1);

  const progress = await bulkSendBatchProgress(pool, batchId);
  assert.equal(progress.byStatus.failed, 1);
  const row = await pool.query('select error from bulk_send_jobs where batch_id = $1', [batchId]);
  assert.equal(row.rows[0].error, 'template not approved');
});

test('re-queuing the same number reuses the existing conversation instead of creating a duplicate', async () => {
  const batchId = randomUUID();
  await queueBulkSend(pool, batchId, [{ waId: '919000000005', name: 'Esha' }], 'drip_day3');
  await runBulkSend({ pool, meta: new FakeMeta(), config: testConfig, log: silentLog });

  const batchId2 = randomUUID();
  await queueBulkSend(pool, batchId2, [{ waId: '919000000005', name: 'Esha' }], 'drip_day3');
  await runBulkSend({ pool, meta: new FakeMeta(), config: testConfig, log: silentLog });

  const count = await pool.query('select count(*)::int as n from conversations');
  assert.equal(count.rows[0].n, 1);
});

async function insertApprovedTemplate(name = 'drip_day3') {
  await pool.query(
    `insert into templates (name, language, category, body, status, active) values ($1, 'en', 'MARKETING', 'Hi {{1}}', 'APPROVED', true)`,
    [name],
  );
}

test('POST /api/bulk-send reads an uploaded xlsx, rejects a template that is not approved', async () => {
  const app = await buildApp(new FakeMeta());
  const token = await tokenFor(app);
  const file = await buildLeadsXlsx(['Name', 'Mobile'], [{ Name: 'Asha', Mobile: '919000000010' }]);

  const notApproved = await bulkSendRequest(app, token, { file, fields: { templateName: 'not_a_real_template' } });
  assert.equal(notApproved.statusCode, 400);

  await insertApprovedTemplate();
  const file2 = await buildLeadsXlsx(['Name', 'Mobile'], [
    { Name: 'Asha', Mobile: '919000000010' },
    { Name: 'Bhavesh', Mobile: '919000000011' },
    { Name: 'No Number Here', Mobile: '' },
  ]);
  const res = await bulkSendRequest(app, token, { file: file2, fields: { templateName: 'drip_day3' } });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.queued, 2);
  assert.equal(body.skipped, 1, 'the row with no mobile number is reported, not silently dropped');

  const progress = await app.inject({ method: 'GET', url: `/api/bulk-send/${body.batchId}`, headers: { authorization: `Bearer ${token}` } });
  assert.equal(progress.json().progress.total, 2);
  await app.close();
});

test('the mobile column is matched by header name, not position, and a missing mobile column is rejected with a clear error', async () => {
  await insertApprovedTemplate();
  const app = await buildApp(new FakeMeta());
  const token = await tokenFor(app);

  // Mobile is the second column here, Email the first - order must not matter.
  const file = await buildLeadsXlsx(['Email', 'Mobile', 'Name'], [
    { Email: 'chetan@example.com', Mobile: '919000000030', Name: 'Chetan' },
  ]);
  const res = await bulkSendRequest(app, token, { file, fields: { templateName: 'drip_day3' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().queued, 1);

  const noMobileCol = await buildLeadsXlsx(['Name', 'Email'], [{ Name: 'Chetan', Email: 'chetan@example.com' }]);
  const rejected = await bulkSendRequest(app, token, { file: noMobileCol, fields: { templateName: 'drip_day3' } });
  assert.equal(rejected.statusCode, 400);
  assert.match(rejected.json().error, /mobile/i);
  await app.close();
});

test('POST /api/bulk-send rejects a topicId for a service that does not exist, with a 400 not a raw db error', async () => {
  await insertApprovedTemplate();
  const app = await buildApp(new FakeMeta());
  const token = await tokenFor(app);
  const file = await buildLeadsXlsx(['Mobile'], [{ Mobile: '919000000012' }]);

  const res = await bulkSendRequest(app, token, { file, fields: { templateName: 'drip_day3', topicId: 999999 } });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('an opted-out number is excluded from a bulk send and reported back', async () => {
  await insertApprovedTemplate();
  await pool.query("insert into contacts (wa_id, opted_out_at) values ('919000000099', now())");
  const app = await buildApp(new FakeMeta());
  const token = await tokenFor(app);
  const file = await buildLeadsXlsx(['Mobile', 'Name'], [
    { Mobile: '919000000098', Name: 'Included' },
    { Mobile: '919000000099', Name: 'Opted out' },
  ]);

  const res = await bulkSendRequest(app, token, { file, fields: { templateName: 'drip_day3' } });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.queued, 1);
  assert.equal(body.optedOut, 1);
  assert.equal(body.total, 2);

  const jobs = await pool.query('select wa_id from bulk_send_jobs');
  assert.deepEqual(jobs.rows.map((r) => r.wa_id), ['919000000098']);
  await app.close();
});

test('a bulk send job queued before an opt-out is marked skipped, not sent', async () => {
  const batchId = randomUUID();
  await queueBulkSend(pool, batchId, [{ waId: '919000000097', name: 'Late opt out' }], 'drip_day3');
  await pool.query("insert into contacts (wa_id, opted_out_at) values ('919000000097', now())");

  const meta = new FakeMeta();
  const processed = await runBulkSend({ pool, meta, config: testConfig, log: silentLog });
  assert.equal(processed, 0, 'nothing gets sent to an opted-out number');
  assert.equal(meta.templates.length, 0);

  const progress = await bulkSendBatchProgress(pool, batchId);
  assert.equal(progress.byStatus.skipped, 1);
});

test('GET /api/bulk-send/batches lists recent batches with their progress', async () => {
  await insertApprovedTemplate();
  const app = await buildApp(new FakeMeta());
  const token = await tokenFor(app);
  const file = await buildLeadsXlsx(['Mobile'], [{ Mobile: '919000000013' }]);

  await bulkSendRequest(app, token, { file, fields: { templateName: 'drip_day3' } });

  const res = await app.inject({ method: 'GET', url: '/api/bulk-send/batches', headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().batches.length, 1);
  assert.equal(res.json().batches[0].total, 1);
  await app.close();
});

test('when Meta normalises the dialled number to a different wa_id, the contact is corrected before the lead can reply and end up as a second contact', async () => {
  const batchId = randomUUID();
  await queueBulkSend(pool, batchId, [{ waId: '919000000020', name: 'Farah' }], 'drip_day3');

  const meta = new FakeMeta();
  meta.canonicalWaId = '9000000020'; // Meta drops the leading '91' for this one
  await runBulkSend({ pool, meta, config: testConfig, log: silentLog });

  const contactsAfterSend = await pool.query('select wa_id from contacts');
  assert.equal(contactsAfterSend.rows.length, 1, 'still one contact');
  assert.equal(contactsAfterSend.rows[0].wa_id, '9000000020', 'corrected to the id Meta actually uses for this lead');

  // The lead's own reply arrives under that same canonical id.
  await recordInbound(pool, {
    waId: '9000000020', name: 'Farah', waMessageId: 'wamid.REPLY1', type: 'text', body: 'hi, got your message',
    referral: null, raw: {},
  });

  const contacts = await pool.query('select count(*)::int as n from contacts');
  const conversations = await pool.query('select count(*)::int as n from conversations');
  assert.equal(contacts.rows[0].n, 1, 'the reply matched the existing contact instead of creating a duplicate');
  assert.equal(conversations.rows[0].n, 1);
});

test('reconcileContactWaId leaves things alone rather than crash when the canonical id already belongs to a different contact', async () => {
  const batchId = randomUUID();
  await queueBulkSend(pool, batchId, [{ waId: '919000000021', name: 'Gopal' }], 'drip_day3');
  await runBulkSend({ pool, meta: new FakeMeta(), config: testConfig, log: silentLog });

  // A second, genuinely separate lead already has the wa_id we are about to
  // try to reconcile onto - this must not blow up with a unique violation.
  await recordInbound(pool, {
    waId: '919000000099', name: 'Someone Else', waMessageId: 'wamid.OTHER1', type: 'text', body: 'hi',
    referral: null, raw: {},
  });

  const conv = await pool.query(`select c.id from conversations c join contacts ct on ct.id = c.contact_id where ct.wa_id = '919000000021'`);
  await assert.doesNotReject(reconcileContactWaId(pool, conv.rows[0].id, '919000000099'));

  const stillSeparate = await pool.query("select wa_id from contacts where wa_id = '919000000021'");
  assert.equal(stillSeparate.rows.length, 1, 'the original contact is untouched, left for a human to merge by hand');
});
