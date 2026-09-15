// Turns a client-pasted block of leads into structured rows for bulk send.
// One lead per line, comma separated, order-tolerant: whichever field on the
// line looks like a phone number is used as the phone regardless of where it
// sits, so "Priya, 91 98765 43210" and "91 98765 43210, Priya" both work -
// the client is pasting out of a spreadsheet, not filling in a form, and
// column order varies between exports.

const PHONE_CHARS = /^[\d\s+().-]+$/;
const EMAIL_RE = /^\S+@\S+\.\S+$/;

function digitsOnly(s) {
  return s.replace(/\D/g, '');
}

export function parseLeadsText(raw) {
  const rows = [];
  const invalid = [];
  const seen = new Set();

  const lines = String(raw || '').split('\n');
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const fields = line.split(',').map((f) => f.trim()).filter(Boolean);
    if (fields.length === 0) continue;

    let phoneField = null;
    const rest = [];
    for (const f of fields) {
      if (!phoneField && PHONE_CHARS.test(f) && digitsOnly(f).length >= 8 && digitsOnly(f).length <= 15) {
        phoneField = f;
      } else {
        rest.push(f);
      }
    }

    if (!phoneField) {
      invalid.push({ line, reason: 'no valid phone number found' });
      continue;
    }

    const waId = digitsOnly(phoneField);
    let email = null;
    const nameAndBusiness = [];
    for (const f of rest) {
      if (!email && EMAIL_RE.test(f)) email = f;
      else nameAndBusiness.push(f);
    }

    if (seen.has(waId)) continue; // last occurrence loses to first - keep the paste's own order predictable
    seen.add(waId);

    rows.push({
      waId,
      name: nameAndBusiness[0] || null,
      business: nameAndBusiness[1] || null,
      email,
    });
  }

  return { rows, invalid };
}
