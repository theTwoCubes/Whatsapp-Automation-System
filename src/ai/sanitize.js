// Strips anything that would make a reply look machine written so it reads like
// a person typed it on WhatsApp. No markdown, no asterisk formatting, no em
// dashes, no heading or bullet syntax.
export function humanize(text) {
  if (!text) return text;
  let t = String(text);

  t = t.replace(/\*\*(.*?)\*\*/g, '$1'); // **bold**
  t = t.replace(/__(.*?)__/g, '$1'); // __bold__
  t = t.replace(/(^|\s)\*(\S(?:.*?\S)?)\*(?=\s|$)/g, '$1$2'); // *emphasis*
  t = t.replace(/(^|\s)_(\S(?:.*?\S)?)_(?=\s|$)/g, '$1$2'); // _emphasis_
  t = t.replace(/`([^`]+)`/g, '$1'); // `code`
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, ''); // # headings
  t = t.replace(/^\s*[-*+]\s+/gm, ''); // bullet markers
  t = t.replace(/^\s*\d+\.\s+/gm, ''); // numbered list markers
  t = t.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'); // [text](url) -> text
  t = t.replace(/\s*—\s*/g, ' - '); // em dash
  t = t.replace(/\s*–\s*/g, ' - '); // en dash
  t = t.replace(/\n{3,}/g, '\n\n'); // collapse extra blank lines

  return t.trim();
}

// Every link a lead is supposed to receive - a payment link, a hosted link, a
// media file - is sent by the server as its own message, picked by id from a
// list the client controls. So a url appearing in the model's own reply text
// is never a real one: it is the model filling in a blank after "here's the
// link:" with something that looks plausible and 404s. Telling it not to in
// the prompt is not enough, and a dead payment link in front of a paying
// customer is about the worst thing this bot can do, so the reply text is
// cleaned here instead of trusted.
//
// allowed is the handful of urls the business genuinely does share in
// conversation (its own website, its instagram). Those survive; anything else
// is removed along with the dangling "here's the link:" lead-in, because a
// sentence ending in a colon with nothing after it reads broken.
const URL_RE = /\bhttps?:\/\/[^\s<>()[\]]+|\bwww\.[^\s<>()[\]]+/gi;

export function stripUnapprovedLinks(text, allowed = []) {
  if (!text) return { text, stripped: [] };

  const normalise = (u) =>
    String(u || '')
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/\/+$/, '');
  const allowSet = new Set(allowed.filter(Boolean).map(normalise));

  const stripped = [];
  let t = String(text).replace(URL_RE, (match) => {
    // Trailing sentence punctuation is not part of the url.
    const trailing = match.match(/[.,;:!?)]+$/)?.[0] ?? '';
    const bare = trailing ? match.slice(0, -trailing.length) : match;
    if (allowSet.has(normalise(bare))) return match;
    stripped.push(bare);
    return trailing;
  });

  if (stripped.length === 0) return { text, stripped };

  // Clean up what the removal left behind: a line that was only a url, a
  // dangling colon or dash before where it used to be, and doubled spaces.
  t = t
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([.,!?])/g, '$1')
    .replace(/^[ \t]*[-:]\s*$/gm, '')
    .replace(/[ \t]*[:-][ \t]*$/gm, '')
    .replace(/\n{3,}/g, '\n\n');

  return { text: t.trim(), stripped };
}
