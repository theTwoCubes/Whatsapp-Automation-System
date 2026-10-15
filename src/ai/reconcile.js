// The invariants code enforces over whatever the model proposes.
//
// Everything in here exists because the prompt is advisory and this is not.
// A rule written in prose is followed most of the time, and "most of the time"
// is the wrong standard for telling a customer their money arrived or for
// deciding which service they are being charged for. The model proposes; these
// functions decide. Each one returns what it changed so the caller can log it,
// because an invariant that trips silently is a bug nobody finds.

// ---------------------------------------------------------------------------
// Payment claims
// ---------------------------------------------------------------------------

// Nothing in this system can see a payment. There is no payment-provider
// webhook; the only source is the customer saying so. A reply that states
// their money has arrived is therefore always a guess dressed as a fact, and
// if it is wrong the business has told someone their payment is settled when
// it is not. The team gets notified of the claim either way - that part is
// real - but the customer only ever hears that we have noted it.
const PAYMENT_ASSERTIONS = [
  /\bpayments?\s+(?:has\s+been\s+|is\s+|was\s+|been\s+)?(?:received|confirmed|successful|completed|credited|cleared)\b/i,
  /\b(?:we|i)\s*(?:'ve|\s+have)?\s*(?:now\s+)?(?:received|confirmed|got)\s+(?:your|the)\s+payments?\b/i,
  /\b(?:received|confirmed)\s*[,!.]?\s*thank\s*you\b/i,
  /\bthanks?\s*(?:you)?[,!]?\s*(?:your\s+)?payments?\s+(?:received|confirmed)\b/i,
  /\bthank\s*you\s+for\s+(?:your\s+)?payment\b/i,
  /\bthat'?s\s+received\b/i,
  /\bthat\s+is\s+received\b/i,
  /\bit'?s\s+received\b/i,
  // Hinglish and Hindi, which is how most of these conversations actually run.
  // The verb ending varies with what it agrees with - gaya, gayi, gaye - so
  // all three are matched: "paise aa gaye hain" slipped through a pattern
  // that only had the first two.
  /\bpayments?\s+(?:mil\s*gay[aie]|ho\s*gay[aie]|aa\s*gay[aie]|receive\s+ho\s*gay[aie])\b/i,
  /\bpais[ae]\s+(?:mil\s*gay[aie]|aa\s*gay[aie])\b/i,
  /\bpayments?\s+confirm\s+ho\s*gay[aie]\b/i,
];

// A sentence that only talks about what happens *after* or *once* a payment
// lands is describing a condition, not confirming one. "Once your payment is
// received, Maulikbhai will call you" has to stay sayable.
const CONDITIONAL_MARKERS = /\b(?:once|after|when|whenever|if|as\s+soon\s+as|jab|jaise\s*hi|agar|ke\s*baad)\b/i;

function splitSentences(text) {
  // Keeps the delimiter with the sentence so rejoining preserves the original
  // punctuation and line breaks.
  return String(text).split(/(?<=[.!?\n])/);
}

export function findPaymentAssertions(text) {
  if (!text) return [];
  const hits = [];
  for (const sentence of splitSentences(text)) {
    if (CONDITIONAL_MARKERS.test(sentence)) continue;
    for (const re of PAYMENT_ASSERTIONS) {
      if (re.test(sentence)) {
        hits.push(sentence.trim());
        break;
      }
    }
  }
  return hits;
}

// Last-resort rewrite, used only when the model has already been asked once to
// say this differently and would not. Drops the offending sentences and puts a
// neutral acknowledgement in their place rather than sending nothing, since
// the customer has just told us something and deserves an answer.
const SAFE_ACKNOWLEDGEMENT = {
  hinglish: 'Thanks for letting me know - main team ko bata deta hoon, wo aapse personally connect karenge.',
  hindi: 'Batane ke liye dhanyavaad - main team ko soochit kar deta hoon, wo aapse personally sampark karenge.',
  english: "Thanks for letting me know - I've passed it to the team and they'll personally take it from here.",
};

function acknowledgementFor(language) {
  const lang = String(language || '').toLowerCase();
  if (lang.includes('hinglish')) return SAFE_ACKNOWLEDGEMENT.hinglish;
  if (lang.includes('hindi') || lang.includes('gujarati') || lang.includes('marathi')) return SAFE_ACKNOWLEDGEMENT.hindi;
  return SAFE_ACKNOWLEDGEMENT.english;
}

export function redactPaymentAssertions(text, language) {
  const hits = findPaymentAssertions(text);
  if (hits.length === 0) return { text, redacted: [] };

  const kept = [];
  for (const sentence of splitSentences(text)) {
    const offending = !CONDITIONAL_MARKERS.test(sentence)
      && PAYMENT_ASSERTIONS.some((re) => re.test(sentence));
    if (!offending) kept.push(sentence);
  }

  const remainder = kept.join('').replace(/\n{3,}/g, '\n\n').trim();
  const safe = acknowledgementFor(language);
  return {
    text: remainder ? `${safe} ${remainder}`.trim() : safe,
    redacted: hits,
  };
}

// ---------------------------------------------------------------------------
// Lead fields
// ---------------------------------------------------------------------------

// Values that answer the question without saying anything. "For my business"
// became lead_business = "business", which reads as a filled field to the
// qualification gate and as nothing at all to the person picking the lead up.
const CONTENTLESS_BUSINESS = new Set([
  'business', 'my business', 'our business', 'the business', 'business hai',
  'company', 'my company', 'our company', 'firm', 'my firm',
  'work', 'my work', 'job', 'shop', 'startup', 'service', 'services',
  'na', 'none', 'nothing', 'n/a', 'na hai', 'pata nahi', 'nahi pata',
  'yes', 'no', 'ok', 'okay', 'haan', 'nahi', 'hmm',
]);

const CONTENTLESS_GENERIC = new Set([
  'na', 'none', 'nothing', 'n/a', 'yes', 'no', 'ok', 'okay', 'haan', 'nahi',
  'hmm', 'pata nahi', 'nahi pata', 'idk', 'dont know', "don't know",
]);

function normaliseValue(v) {
  return String(v ?? '').toLowerCase().replace(/[^a-z0-9\s/']/g, ' ').replace(/\s+/g, ' ').trim();
}

// serviceNames lets the checks reject a lead_business or lead_requirement that
// is only the name of the service they want. "Scientific Logo Design" is what
// they are buying, not what their business does and not a brief the team can
// act on, and storing it as either leaves a lead who looks complete and is not.
export function validateLeadProfile(profile, { serviceNames = [] } = {}) {
  if (!profile) return { profile: null, rejected: [] };

  const services = new Set(serviceNames.map(normaliseValue).filter(Boolean));
  const clean = {};
  const rejected = [];

  const reject = (field, value, why) => rejected.push({ field, value, why });

  for (const [field, raw] of Object.entries(profile)) {
    const value = typeof raw === 'string' ? raw.trim() : raw;
    if (value === undefined || value === null || value === '') continue;

    const norm = normaliseValue(value);

    if (field === 'business') {
      if (norm.length < 3) { reject(field, value, 'too short to mean anything'); continue; }
      if (CONTENTLESS_BUSINESS.has(norm)) { reject(field, value, 'says nothing about the business'); continue; }
      if (services.has(norm)) { reject(field, value, 'this is the service they want, not their business'); continue; }
    }

    if (field === 'requirement') {
      if (norm.length < 3) { reject(field, value, 'too short to mean anything'); continue; }
      if (CONTENTLESS_GENERIC.has(norm)) { reject(field, value, 'not a requirement'); continue; }
      if (services.has(norm)) { reject(field, value, 'the service name alone is not a brief'); continue; }
    }

    if ((field === 'address' || field === 'name') && norm.length < 2) {
      reject(field, value, 'too short to be real'); continue;
    }

    if ((field === 'budget' || field === 'timeline') && CONTENTLESS_GENERIC.has(norm)) {
      reject(field, value, 'not an answer'); continue;
    }

    clean[field] = value;
  }

  return { profile: Object.keys(clean).length > 0 ? clean : null, rejected };
}

// ---------------------------------------------------------------------------
// Repeated replies
// ---------------------------------------------------------------------------

function normaliseReply(text) {
  return String(text ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Word overlap, not character distance: the failure mode in production was the
// same message reworded, not mistyped. "Aap apna logo bhej sakte hain, aur fir
// ₹510 ka charge hoga" against "Aap apna existing logo bhej sakte hain, aur fir
// ₹510 ka charge hoga" shares nearly every word and is the same turn twice.
function similarity(a, b) {
  const left = new Set(normaliseReply(a).split(' ').filter(Boolean));
  const right = new Set(normaliseReply(b).split(' ').filter(Boolean));
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / Math.max(left.size, right.size);
}

// Below this length, word overlap stops meaning much - "haan bilkul" and
// "haan theek hai" would score as near-identical while being perfectly fine
// consecutive replies. Short texts are only caught when they are exactly equal.
const SIMILARITY_MIN_CHARS = 45;
const SIMILARITY_THRESHOLD = 0.8;

export function isRepeatOf(candidate, previousReplies = []) {
  const text = String(candidate ?? '').trim();
  if (!text) return null;
  const norm = normaliseReply(text);
  if (!norm) return null;

  for (const previous of previousReplies) {
    if (!previous) continue;
    if (normaliseReply(previous) === norm) return { previous, score: 1 };
    if (norm.length >= SIMILARITY_MIN_CHARS) {
      const score = similarity(text, previous);
      if (score >= SIMILARITY_THRESHOLD) return { previous, score };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Which service a conversation is about
// ---------------------------------------------------------------------------

// Where the recorded service came from, strongest first. A campaign is a fact
// about how the lead arrived. "stated" is the customer having said it. An
// "inferred" value is the model's best read and is held provisionally - it is
// never spoken of as settled, and it never blocks a better answer later.
export const SERVICE_BASIS = { campaign: 3, stated: 2, inferred: 1, unset: 0 };

// The rule the client asked for: a lead on Scientific Logo Design who later
// says "logo" in passing is still on Scientific Logo Design. Moving an
// established service takes an explicit, stated switch - not a word that
// happens to overlap with another service's name.
export function resolveService({ current, currentBasis, proposed, proposedBasis, isChange }) {
  const have = SERVICE_BASIS[currentBasis] ?? SERVICE_BASIS.unset;
  const want = SERVICE_BASIS[proposedBasis] ?? SERVICE_BASIS.unset;

  if (!proposed) return { service: current, basis: currentBasis, changed: false, why: 'nothing proposed' };
  if (!current) {
    return { service: proposed, basis: proposedBasis, changed: true, why: 'no service recorded yet' };
  }
  if (String(proposed) === String(current)) {
    // Same service, but the model may have firmed up why it believes it.
    if (want > have) return { service: current, basis: proposedBasis, changed: false, why: 'same service, firmer basis' };
    return { service: current, basis: currentBasis, changed: false, why: 'unchanged' };
  }

  // A different service. Only an explicit switch the customer actually stated
  // can move it, and never away from the campaign they arrived through unless
  // they say so outright.
  if (isChange && want >= SERVICE_BASIS.stated) {
    return { service: proposed, basis: proposedBasis, changed: true, why: 'customer stated a switch' };
  }
  return { service: current, basis: currentBasis, changed: false, why: 'passing mention, not a switch' };
}
