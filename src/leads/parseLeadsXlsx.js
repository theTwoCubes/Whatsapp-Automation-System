import ExcelJS from 'exceljs';

// Reads a client-uploaded spreadsheet of leads for bulk send. Columns are
// matched by header name in row 1 (case/spacing insensitive), not position,
// so the client's own column order never matters. Only "mobile" (or an
// obvious alias) is required - everything else is a bonus the AI would
// otherwise have to ask the lead for itself.
const HEADER_ALIASES = {
  mobile: ['mobile', 'mobile number', 'phone', 'phone number', 'number', 'whatsapp', 'whatsapp number', 'wa_id', 'waid'],
  name: ['name', 'lead name', 'contact name', 'full name'],
  email: ['email', 'e-mail', 'email address'],
  business: ['business', 'company', 'business name', 'company name'],
};

function normaliseHeader(value) {
  return String(value ?? '').trim().toLowerCase();
}

// A cell can come back as a plain value, a rich-text object, or a formula
// result - this flattens all of those to the plain text a person would see.
function cellText(cell) {
  const v = cell?.value;
  if (v == null) return '';
  if (typeof v === 'object') {
    if ('result' in v) return String(v.result ?? '');
    if ('text' in v) return String(v.text ?? '');
    if ('richText' in v) return v.richText.map((r) => r.text).join('');
  }
  return String(v).trim();
}

// A safety ceiling on how many rows are ever scanned, independent of the
// business-level MAX_BULK_SEND_ROWS check in the route. Excel files routinely
// report a rowCount far past their real data - stray formatting on a huge
// unused range is enough to inflate it into the millions - so this bounds
// worst-case parse time for an uploaded file regardless of how the sheet's
// dimensions look, rather than trusting sheet.rowCount outright.
const MAX_ROWS_SCANNED = 20000;

export async function parseLeadsXlsx(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) return { rows: [], invalid: [], error: 'the file has no sheets' };

  const columnFor = {};
  sheet.getRow(1).eachCell((cell, colNumber) => {
    const header = normaliseHeader(cell.value);
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
      if (columnFor[field] == null && aliases.includes(header)) columnFor[field] = colNumber;
    }
  });

  if (columnFor.mobile == null) {
    return {
      rows: [],
      invalid: [],
      error: 'no "mobile" column found - the first row must have column headers, with one named mobile (phone, number, or whatsapp also work)',
    };
  }

  const rows = [];
  const invalid = [];
  const seen = new Set();
  const lastRow = Math.min(sheet.rowCount, MAX_ROWS_SCANNED + 1);
  for (let r = 2; r <= lastRow; r++) {
    const row = sheet.getRow(r);
    const mobileRaw = cellText(row.getCell(columnFor.mobile));
    const name = columnFor.name ? cellText(row.getCell(columnFor.name)) : '';
    const email = columnFor.email ? cellText(row.getCell(columnFor.email)) : '';
    const business = columnFor.business ? cellText(row.getCell(columnFor.business)) : '';
    if (!mobileRaw && !name && !email && !business) continue; // fully blank row

    const waId = mobileRaw.replace(/\D/g, '');
    if (waId.length < 8 || waId.length > 15) {
      invalid.push({ row: r, reason: mobileRaw ? `invalid mobile number "${mobileRaw}"` : 'missing mobile number' });
      continue;
    }
    if (seen.has(waId)) continue; // first occurrence wins, same as everywhere else leads are deduped
    seen.add(waId);

    rows.push({ waId, name: name || null, email: email || null, business: business || null });
  }

  const truncated = sheet.rowCount > lastRow;
  return { rows, invalid, truncated };
}
