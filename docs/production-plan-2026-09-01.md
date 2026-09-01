# Production plan — 2026-09-01

Scope: everything requested in the "hosted on VPS" message. Covers knowledge
loading, handoff calibration, latency, media, profile photos, chat-list agent
indicator, notification center rework, WhatsApp-like polish, missed-message
backfill, plus places to inject high-quality knowledge for production-grade
behaviour.

Naming: **AdVoice Inc.** is the client business (the one shown to the lead).
**theTwoCubes** is the vendor building the app (shown only where the vendor
should be credited: watermark, support email, admin login, footer, "made by").

---

## 0. What already landed in this pass

1. Three condensed FAQ packs written to `faq/packs/*.md`:
   - `base.md` (identity, contact, billing entities, payment, refund, languages, greetings, handoff triggers, out of scope)
   - `logo-design.md`
   - `brochure-catalogue-design.md`
   - `scientific-logo-design.md` (with Hinglish/language rules baked into the pack itself, plus the "never diagnose over WhatsApp" positioning rules)
2. Seed script `scripts/seed-faqs.js`. Reads the `.md` files, upserts topics, replaces the FAQ rows for each pack in one transaction. Idempotent — run it as often as you want.
3. `.env` — `BUSINESS_NAME` normalised to `AdVoice Inc.`, `BUSINESS_ABOUT` extended with scientific logo design, billing entities, payment structure, and locations. Added `BUSINESS_LOCATION` and `BUSINESS_FOUNDED`.
4. `src/ai/reply.js` — language rule added (mixed messages → English only, simple vocabulary), greeting-and-small-talk exception added so the bot no longer hands off on "hi".

## 1. How to load the FAQs on the VPS (item 5)

Two options. Pick one, they do the same thing.

**A. Over SSH with the seed script (recommended).**
```bash
ssh user@advoice.online
cd /path/to/app                       # wherever the app lives
git pull                              # pull the new faq/packs/*.md + scripts/seed-faqs.js
node scripts/seed-faqs.js             # loads all four packs
# or, one at a time:
node scripts/seed-faqs.js base
node scripts/seed-faqs.js logo-design
```
No app restart needed. The reply path reads FAQs live per conversation.

**B. Through the admin console.** Open the Knowledge page, pick each pack, use "Import" if you've added a bulk-import button (see item 7 in the punchlist), otherwise the pack files are copy-paste-friendly. The seed script is faster and safer.

Verify: on the server, `psql "$DATABASE_URL" -c "select topic_id, count(*) from faqs group by topic_id order by topic_id"` — should show one row for `NULL` (base) and one row per service topic.

## 2. Handoff calibration (items 6 and 8)

**Root cause.** The bot was handing off on "hi" because:
1. The prompt says "hand over when you're unsure" — a bare greeting has nothing to be sure about.
2. Knowledge was too thin — any specific question fell off the edge of the pack.
3. There was no explicit "greetings are yours" clause.

**Fixes.**

Landed today:
- Greeting-and-small-talk clause in the system prompt: bot replies to hi/hello/hey/namaste/thanks/ok in one line and asks what they need. Only hands over on a real question.
- Base pack now contains explicit greetings, out-of-scope, and handoff-trigger sections so "hand off" is a positive decision, not a fallback.

Still to do (not landed yet, but easy follow-ups):
- Add a `confidence` field to the JSON contract (`answer|handoff` + `confidence: high|medium|low`). If confidence is `low` and reason is "unsure", still send the answer but log it separately so we can see which packs are thin.
- Log every handoff row with `reason`, `top_faq_match_score`, `pack_ids_active`. Surface this in an admin "why do we hand off?" report — that's how we know which service pack needs more FAQs next month.
- Add a lightweight negative-list check before the AI call: if the message is empty, is a sticker, is only emojis, or matches known greeting-only regex, respond with a canned greeting from the base pack without a model call at all. Zero latency, zero cost.

## 3. Latency bottlenecks (item 9)

Ordered by how much they hurt at scale. Each item is small; batch them into one or two evenings.

1. **Model call is the biggest single hop.** Gemini 3.5 Flash is fine. Make sure `.env` `GEMINI_MODEL` is spelled correctly — current value `gemini-3.5-flash` is a placeholder that will 400 in prod; the correct id at time of writing is `gemini-2.5-flash` (verify against the current Gemini docs on the VPS before switching). While there, turn on request timeout of ~15s so a hung call doesn't block the batch.
2. **Prompt size.** With three packs loaded the prompt grows. Two saves: (a) the "shared prefix" pattern already in `reply.js` is right — keep it, don't stuff per-lead context into the first system message; (b) let the pack context builder drop pinned=false FAQs first when the budget bites.
3. **`FAQ_BUDGET_TOKENS=6000`** is generous for one pack, tight for three. Bump to 9000 or 12000 as long as p95 latency stays under 4s.
4. **DB round-trips per reply.** `buildReply` does 4 queries in parallel — good. Add a small in-memory 60s cache for `buildFaqContext(packs)` keyed by pack ids, since 100 leads on the same pack build the exact same prompt.
5. **`getConversationHistory(pool, id, 14)`** — 14 turns is fine for behaviour, but add an index on `messages(conversation_id, created_at desc)` if not already there. Check with `\d messages` on prod.
6. **Webhook → reply chain.** Message hits webhook → verify → insert → batch debounce (2500ms) → build reply → send. Debounce is the biggest visible latency to the lead. Consider dropping it to 1500ms for short messages (single word) and keeping 2500ms for messages that end mid-sentence.
7. **WhatsApp send path.** The Meta Graph call is 300–800ms typically. Not much to do except pipeline concurrent replies. Ensure connection keep-alive on the axios/fetch client.
8. **WebSocket fan-out.** With one agent it's free. When you add more agents, use per-agent rooms instead of broadcasting to all.
9. **Startup warnings already emit** if VAPID or FCM are missing — good, keep those.

## 4. Media / attachments — universal downloads (item 11)

**Current issue.** Some MIME types don't download because the frontend/backend has a narrow allowlist somewhere.

**Fix path.**
- `src/routes/media.js` (or wherever media serve is): confirm there's no `if (type !== 'image/...') 403`. Whatever WhatsApp accepts inbound, we should stream out.
- Frontend `api.mediaObjectUrl` should pass through the server-fetched blob and hand it to `<a download>` regardless of type. Audio should render an inline `<audio controls>` player, video an inline `<video controls>` player, documents a "Download" chip.
- Audio inbound: WhatsApp sends `audio/ogg` (voice notes) and `audio/mpeg`. Make sure both stream and play. Also add `application/ogg` to the safe types.
- Audio outbound: WhatsApp Cloud API supports sending audio via `messages` with `type: audio` and either a media id or a link. Add a "Send audio" button next to the existing image/document buttons. Note: WhatsApp only accepts `audio/aac`, `audio/mp4`, `audio/mpeg`, `audio/amr`, `audio/ogg` (OPUS only). Reject others on the frontend before upload.
- Capacitor native path already goes through `@capacitor/share` — good. Just make sure the share call passes the right MIME so Android's share sheet picks the right handlers.

## 5. Profile photos (item 12)

**WhatsApp Cloud API does not expose contact profile photos on business-received messages.** That's a WhatsApp privacy decision — the Cloud API's `contacts` webhook payload gives you the wa_id and the profile name, nothing else. The on-your-phone WhatsApp app uses a different consumer API that can see photos. There is no supported way to fetch them from the Business Cloud API.

**What we can do that looks intentional.**
- Deterministic coloured avatars from the wa_id or name: hash the wa_id → pick from a palette of ~12 tasteful colours → render the first initial in white. Consistent per contact, no server calls, matches the "WhatsApp style" the client expects.
- If the contact has a saved nickname (the frontend-only wrapper you added), use its first letter, not the wa_id's fallback.
- Optional escalation: if the client is willing to run a manual "sync photos" pass from an actual WhatsApp session (via wa-web or unofficial libraries), we can cache them ourselves. Not recommended — violates WhatsApp ToS and risks the number ban.

Ship the coloured-avatar version. That's the real answer.

## 6. Chat list — agent-mode visual (item 13)

- Add `state === 'human'` styling: a 2px left border in `#f59e0b` (amber, same as unread), plus a tiny "👤 you" chip below the last-message line. Ring the whole row on hover.
- For `state === 'bot'` and `state === 'handoff_pending'` keep it clean.
- Add a legend at the top of the chat list (small text, subtle) — three dots: Bot / You / Waiting. Clicking a dot filters the list.

## 7. Notification center rework (item 14)

**Current problem.** Bell button is misleading — it toggles push and shows nothing.

**New model.** Three separate controls in the top bar:

1. **Bell icon = In-app inbox.** Click opens a right-side drawer with a list of notifications the app has fired at you today (handoff, new inbound in a human chat, mention, etc.). Each row: title, chat name, time, unread dot. Actions: click to jump to chat, mark one read, mark all read. The bell shows a red dot if there are unread rows.
2. **Push toggle (in Settings / a dedicated menu, not the top bar):** three states — On, Off, Denied by browser. Clicking On subscribes, Off unsubscribes, Denied opens a modal explaining how to re-enable in browser settings. Add a "Send test" button that only lights up when state is On.
3. **Second click on the bell should close the drawer.** Currently it's a one-way open. Track `open` state, toggle it.

**Data model.**
Add a table:
```
notifications (
  id bigserial primary key,
  agent_email text not null,
  kind text not null,          -- 'handoff', 'inbound_in_takeover', 'mention'
  conversation_id bigint,
  title text not null,
  body text,
  read_at timestamptz,
  created_at timestamptz not null default now()
)
```
Every push we already send should also write a row here. The inbox is a simple `select * from notifications where agent_email = $1 order by created_at desc limit 50`.

Cap the table at ~30 days or ~500 rows per agent with a nightly cron so it doesn't bloat.

## 8. WhatsApp-like polish (item 15)

Priority order (each one is small):

1. **Pin chat.** New column `conversations.pinned_by jsonb not null default '{}'` (per-agent pin state). Pinned chats sort first, with a pin icon.
2. **Archive chat.** `archived_at timestamptz`. Filter toggle at top: All / Unread / Archived.
3. **Mute chat.** `muted_until timestamptz`. Muted chats don't fire push. Small speaker-off icon.
4. **Starred messages.** New table `starred_messages (message_id, agent_email, created_at)`. New view in the sidebar.
5. **Today / Yesterday / date dividers** in the chat pane. Small pill, sticky.
6. **Unread divider line** (the "unread messages ↓" separator) — pin at first unread on chat open.
7. **Swipe actions on mobile** — swipe right on a chat row to archive/pin, swipe left to mute. Use touch gestures with a small library or hand-rolled.
8. **Message ticks — one/two/blue** already wired for read receipts; verify against Meta's `statuses` webhook (delivered/read events) and confirm the colour choice sticks.
9. **Reply / quote** — click a message → composer pre-fills a quoted block. Meta's send API supports `context.message_id` for reply threading.
10. **Emoji reactions** — Meta's reactions API is live now. Long-press a message → reaction picker.

Do 1–6 first. 7–10 can wait until you have real usage feedback.

## 9. Missed-message backfill (item 16)

**Symptom.** A message came in in the morning while the server was down. It only appeared in the console in the evening.

**Two possible causes.** Diagnose which before fixing.

1. **Webhook retry vs delivery.** WhatsApp Cloud API retries a failed webhook for up to 7 days with exponential backoff — the message shouldn't be lost, but its `created_at` in your DB will be the time the retry succeeded (evening), not the time the lead sent it (morning). Check the message row: if `created_at` is evening but there's a `timestamp` field from the WhatsApp payload showing morning, that's the mismatch. Fix: also store the lead's send time as `sent_at` and sort/display by that.
2. **Server was fully offline and rejected the webhook with 5xx.** Meta will retry. Confirm by looking at Meta's Webhook Delivery logs in the app dashboard for that time window.

**Fixes.**

- Add `sent_at timestamptz` to `messages`, populate from `entry[0].changes[0].value.messages[0].timestamp * 1000`. Show `sent_at` in the UI, keep `created_at` for internal debugging.
- Add a webhook dead-letter table: any webhook payload that throws during processing is stored raw, with error, so it can be replayed manually.
- Health check: `pm2` / `systemd` restart policy on the Node process. If the server crashes, it restarts within seconds — webhook retry then catches up.
- Uptime monitor (external, e.g. Better Uptime free tier) pings `/health` every minute. If it fails, you get an email and can jump on it.

Not a workaround: **never** poll WhatsApp for missed messages. WhatsApp doesn't expose a "list conversations" endpoint on the Business Cloud API — webhook is the only path.

## 10. Where to inject high-quality knowledge for production-grade performance (item 7)

Ranked by ROI.

1. **The three service packs** you just added. Add packs for the remaining services as they come up (packaging, website, digital marketing, video). Even a 30-question pack is enough to keep the bot on-topic.
2. **The base pack.** This is where "who we are, when we reply, what we don't do" lives. Grow it every time a client says "the bot didn't know X" — those are the highest-value FAQ additions.
3. **The system prompt** (`src/ai/reply.js`, `instructions()`). Business tone, language rules, greeting rules, handoff triggers, out-of-scope rules. Anything that applies to *every* conversation goes here, not in a pack.
4. **`BUSINESS_ABOUT`** in `.env`. Update whenever the client changes services, adds an office, or shifts positioning. Short, factual, third-person.
5. **Handoff reason vocabulary.** Right now `reason` is free text. Constrain it to a short enum (`price_negotiation`, `custom_quote`, `complaint`, `personal_meeting`, `unknown_service`, `unsure_answer`, `explicit_request`, `other`). Then the "why do we hand off?" report becomes trivial and knowledge gaps become measurable.
6. **Media descriptions.** Each attachable file has a `description` in the DB. Rewrite these to be specific — the bot reads them, not the file. "Real estate brochure sample — a 12-page premium project brochure showing a similar layout to what we'd design" beats "brochure sample.pdf".
7. **Topic keywords.** Each pack's `keywords` column is what pulls the pack in without a model call. Add real synonyms — "catalog", "product list", "price list", "leaflet" for the brochure pack, and so on.
8. **Simulator scripts.** The FAQ simulator already exists (`src/knowledge/simulator.js`). Write 20 real customer conversations and run them nightly — regressions in behaviour show up immediately.

## 11. Vendor / client branding split

Consistently across the app, use:

- **AdVoice Inc.** — the business the lead is talking to. Appears in: WhatsApp replies (`BUSINESS_NAME`), the console browser tab, the sidebar brand block, invoices, email signatures, all customer-facing copy.
- **theTwoCubes** — the vendor that built the console. Appears in: admin login page footer ("Console by theTwoCubes"), the small "Made by theTwoCubes" watermark (already `BRAND_WATERMARK` in `.env`), the support email (`SUPPORT_EMAIL=build@thetwocubes.com`), the About / Version panel in Admin.

Add this to any new UI: if it faces the lead, use AdVoice; if it's the tool's chrome, keep the theTwoCubes credit small and consistent.

## 12. Execution order (what to ship, in order)

Week 1 (mostly done today):
1. Load the FAQ packs on the VPS (item 5 above). Verify with `psql`.
2. Deploy the reply.js language + greeting changes. Watch the "handoff on hi" problem disappear.
3. Bump `FAQ_BUDGET_TOKENS` if p95 latency stays sub-4s.

Week 2:
4. Media allowlist audit + audio playback (item 4).
5. Deterministic coloured avatars (item 5).
6. `sent_at` column + display (item 9, part 1).

Week 3:
7. Notification center rewrite: `notifications` table, bell drawer, push toggle split (item 7).
8. Chat list agent-mode visual + legend (item 6).

Week 4:
9. Pin / archive / mute (item 8, items 1–3).
10. Handoff reason enum + report (item 10, part 5).

Beyond:
11. Reply threading, reactions, starred messages, swipe actions.
12. Additional service packs for the remaining AdVoice services.

## 13. Rollback safety

Nothing in this plan drops columns or deletes existing rows outside a pack it owns. The seed script runs in one transaction — if a parse fails, nothing is written. The reply-prompt change is behind no flag but is trivial to revert (`git revert`) and doesn't change data.

Take a `pg_dump` before running the seed script on the VPS for the first time. After that, run it freely.

---

Owner: theTwoCubes (Akshat).
Client: AdVoice Inc.
