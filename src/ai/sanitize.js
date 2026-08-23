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
  t = t.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'); // [text](url) -> text
  t = t.replace(/\s*—\s*/g, ' - '); // em dash
  t = t.replace(/\s*–\s*/g, ' - '); // en dash
  t = t.replace(/\n{3,}/g, '\n\n'); // collapse extra blank lines

  return t.trim();
}
