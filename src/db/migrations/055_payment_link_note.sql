-- A fixed line that always goes out underneath a payment link, in the same
-- message as the url. Scientific logo design needs every payment link to be
-- followed by the same instruction about emailing the logo and business
-- details, and the reply text is sent before the link message, so putting it
-- in an FAQ answer would place it above the link rather than below it. This
-- is also not something the AI should be free to paraphrase or forget, so it
-- is appended by the sender rather than generated.
alter table payment_links
  add column if not exists note text;
