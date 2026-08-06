# Troubleshooting

Common problems and what actually causes them. Most WhatsApp issues are
configuration in Meta's dashboard, not bugs in this code.

## Chatwoot inbox shows "disconnected"

Almost always the `messages` webhook field is not subscribed in the Meta app.
Go to the Meta app, WhatsApp, Configuration, Webhooks, and make sure `messages`
is subscribed. A missing subscription gives error `#100` and a permanently
disconnected inbox. Re-check this first before anything else.

## The bot does not reply

Work down this list:

1. Is the conversation assigned to a human agent in Chatwoot? If so, the bot
   stays silent on purpose. That is the manual-takeover toggle. Unassign it to
   hand back to the bot.
2. Is the n8n workflow `01 - Inbound Message` active? Open n8n and check the
   toggle at the top right of the workflow.
3. Is the Chatwoot webhook pointing at the n8n webhook URL? In Chatwoot, the
   automation or webhook that calls n8n must use
   `https://<n8n host>/webhook/chatwoot-inbound`.
4. Open the workflow's execution list in n8n. A failed execution shows exactly
   which node broke. Missing OpenAI key and wrong Chatwoot token are the usual ones.

## OpenAI errors in the execution log

- 401: the `OPENAI_API_KEY` is wrong or expired.
- 429: rate or quota limit on the OpenAI account. Add billing or slow down.

## Prices are wrong or the bot invents a price

The bot only quotes from the `price_text` column in the knowledge base sheet.
If a price looks wrong, fix the sheet. If the bot is guessing, the row for that
service probably has an empty `price_text`, which it should treat as "unknown".
Confirm the sheet is published as CSV and the URL in `.env` is current.

## Template rejected

Usually the copy sounds promotional. Rewrite it toward something genuinely
useful rather than a sales pitch. See docs/template-copy.md for the tone that
tends to pass. You can appeal in WhatsApp Manager, but rewriting is faster.

## Template silently recategorised from Utility to Marketing

This changes the cost per send. Meta allows an appeal, but rewriting the copy to
be clearly useful is generally quicker than winning an appeal.

## Drip sends fail with error 131049

This is Meta's per-user marketing frequency cap. The user is temporarily
unreachable for marketing across all businesses, not just this one. It is not a
bug and not an opt-out. The cron leaves the lead active and retries on the next
run. Do not treat it as an error.

## A sample image fails to send

The media ID has probably expired. Media IDs do not last forever. Run the media
uploader again (workflow `03 - Media Sync`, or the script by hand) to refresh
the IDs in `media_assets`. The send path should be retried after that.

Note: Google Drive share links do not work as WhatsApp media. Drive serves an
HTML preview page, not the raw file. Media must go through Meta's media endpoint,
which is exactly what `scripts/upload_media.py` does.

## Testing the drip on an accelerated clock

You do not want to wait 8 real days to test. Two options:

- Temporarily change the intervals in `02 - Drip Cron` and in the inbound
  workflow's `next_touch_at` from days to minutes, and set the schedule trigger
  to run every minute. Change them back before launch.
- Or set a test lead's `next_touch_at` to `now()` directly in Postgres and watch
  the next cron run pick it up.

Use a template that is already approved for these tests. An unapproved template
name will fail at Meta's server.

## Restore from backup

Backups are written by `scripts/backup.sh` to the `backups/` folder as gzipped
`pg_dumpall` files. To restore, see the runbook in HANDOVER.md.

## Quality rating dropped

Too many people blocked or reported the number, usually because of the drip. The
fix is content quality and sending less, not code. Review the template copy and
consider longer gaps.
