import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';

import { parseLeadsXlsx } from '../../src/leads/parseLeadsXlsx.js';

async function buildXlsx(headers, rows) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Leads');
  sheet.addRow(headers);
  for (const row of rows) sheet.addRow(headers.map((h) => (h in row ? row[h] : '')));
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

test('columns are matched by header name, case and spacing insensitive, in any order', async () => {
  const file = await buildXlsx(['EMAIL', 'mobile ', 'Name'], [
    { EMAIL: 'priya@example.com', 'mobile ': '919000000001', Name: 'Priya' },
  ]);
  const { rows } = await parseLeadsXlsx(file);
  assert.deepEqual(rows, [{ waId: '919000000001', name: 'Priya', email: 'priya@example.com', business: null }]);
});

test('mobile column aliases (phone, number, whatsapp) are all recognised', async () => {
  for (const alias of ['phone', 'number', 'whatsapp']) {
    const file = await buildXlsx([alias], [{ [alias]: '919000000002' }]);
    const { rows } = await parseLeadsXlsx(file);
    assert.equal(rows[0]?.waId, '919000000002', `"${alias}" should be recognised as the mobile column`);
  }
});

test('only mobile is required - name, email, business are all optional', async () => {
  const file = await buildXlsx(['mobile'], [{ mobile: '919000000003' }]);
  const { rows, invalid } = await parseLeadsXlsx(file);
  assert.deepEqual(rows, [{ waId: '919000000003', name: null, email: null, business: null }]);
  assert.equal(invalid.length, 0);
});

test('a row with no usable mobile number is reported invalid, not silently dropped', async () => {
  const file = await buildXlsx(['mobile', 'name'], [
    { mobile: '919000000004', name: 'Good Row' },
    { mobile: '123', name: 'Too Short' },
    { mobile: '', name: 'Blank Mobile' },
  ]);
  const { rows, invalid } = await parseLeadsXlsx(file);
  assert.equal(rows.length, 1);
  assert.equal(invalid.length, 2);
});

test('a fully blank row is skipped silently rather than reported', async () => {
  const file = await buildXlsx(['mobile', 'name'], [
    { mobile: '919000000005', name: 'Real Lead' },
    { mobile: '', name: '' },
  ]);
  const { rows, invalid } = await parseLeadsXlsx(file);
  assert.equal(rows.length, 1);
  assert.equal(invalid.length, 0, 'a genuinely empty row is not the same as a bad one');
});

test('the same mobile number appearing twice only produces one row', async () => {
  const file = await buildXlsx(['mobile', 'name'], [
    { mobile: '919000000006', name: 'First' },
    { mobile: '919000000006', name: 'Duplicate' },
  ]);
  const { rows } = await parseLeadsXlsx(file);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'First');
});

test('a mobile number stored as a spreadsheet number (not text) is still read correctly', async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Leads');
  sheet.addRow(['mobile']);
  sheet.addRow([919000000007]); // a real number cell, not text
  const file = Buffer.from(await workbook.xlsx.writeBuffer());
  const { rows } = await parseLeadsXlsx(file);
  assert.equal(rows[0]?.waId, '919000000007');
});

test('no mobile column at all produces a clear error instead of silently returning nothing', async () => {
  const file = await buildXlsx(['name', 'email'], [{ name: 'Someone', email: 'a@b.com' }]);
  const { rows, error } = await parseLeadsXlsx(file);
  assert.equal(rows.length, 0);
  assert.match(error, /mobile/i);
});
