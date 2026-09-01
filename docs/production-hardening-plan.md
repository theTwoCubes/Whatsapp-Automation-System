# Production hardening plan — AdVoice Inc. WhatsApp console

Vendor: theTwoCubes. Client: AdVoice Inc. Target: a production system a paying
client runs daily, that looks and feels like WhatsApp Business, with a backend
that is fast and hard to corrupt.

This plan is written in phases. Each phase is independently shippable and ends
in a clean commit. Phases 1–5 are correctness and the bugs you named; 6–9 are
parity and polish; 10–15 are reliability, security, and scale. Every phase
lists Findings (what's wrong today, with file:line), Fixes, and Suggestions
(optional upgrades).

A legend for effort: **S** = under an hour, **M** = a few hours, **L** = a day+.

---

## Root-cause analysis of the bugs you reported

Before the phases, here is exactly why the things you saw happen. These are
confirmed from the code, not guesses.

1. **"Toasters come many times for a single notification."**
   `Console.loadList()` fires `toast.warning(... needs a person)` for every
   *fresh* pending chat (`web/src/Console.jsx:289-296`). It dedupes against
   `knownPendingRef`, but that ref is only updated *after* the `await`
   (`:298`). The WebSocket handler calls **both** `loadList(true)` and
   `loadThread()` on every event (`:370-372`), and `loadThread` *also* calls
   `loadList(true)` (`:317`). So two-plus `loadList` calls run concurrently,
   all read the same stale `knownPendingRef`, all see the same pending as
   "fresh", and all toast. Result: 2–4 identical toasts per handoff.

2. **"Notification drawer not working on web."**
   The bell lives in the sidebar footer (`Sidebar.jsx:186`) and the drawer is
   `absolute right-0 top-11` (`NotificationBell.jsx:85`), i.e. it opens
   *downward* from a footer pinned to the bottom of the viewport — so it
   renders below the fold, and the parent `<aside>`/footer clip it. It "opens"
   but you can't see it. It needs to render in a portal and open upward.

3. **"Archive should un-archive when a new message comes."**
   `recordInbound` (`src/db/repo.js:7`) never touches `archived_at`. Archive is
   permanently sticky. A new inbound must clear `archived_at` (and ideally
   `muted_until` if you want mute to behave like WhatsApp, which keeps mute).

4. **"No option to unarchive / unpin / unmute / delete / block."**
   Pin/mute/archive toggle buttons exist but are `hidden md:flex`
   (`Console.jsx` header) — invisible on mobile, and there's no per-row
   action anywhere. Delete, block, and unblock don't exist at all in the
   backend or UI.

5. **Bonus bugs found during the read (not yet reported by you):**
   - Every WS event refetches the entire list *and* the entire open thread
     (`Console.jsx:370-372`) — no payload targeting. Wasteful and a source of
     flicker.
   - `getConversationMessages` orders by `created_at` (`repo.js:354`) but the
     rest of the app now sorts by `sent_at` — a late webhook shows in the
     wrong place inside a thread.
   - Two `NotificationBell` instances (mobile + desktop) each poll every 30s
     independently (`NotificationBell.jsx:33`), doubling requests and drifting
     out of sync.
   - `applyBadge(pending.size)` counts only pending, ignoring unread messages
     in human-owned chats.
   - `sendAndRecord` has a leftover `console.error(err)` (`message.js:353`).
   - `GEMINI_MODEL=gemini-3.5-flash` in `.env` is not a real model id — this
     will 400 on every call in prod. Must be a valid id (e.g.
     `gemini-2.5-flash`), verified against the live API.
   - FAQ context is rebuilt from the DB on every single reply with no cache
     (`context.js:18`), and `trimToBudget` re-renders the whole text on every
     loop iteration (`context.js:50`) — O(n²).

---

## Phase 1 — Stop the bleeding: the four bugs you named (M)

Goal: the reported defects gone, nothing else touched.

Fixes:
- **Duplicate toasts.** Move handoff notifications out of `loadList` entirely.
  Track already-alerted conversation ids in a ref that is updated
  *synchronously* the moment an id is seen, before any await. Better: derive
  "new pending" from the WS event payload, not from a full-list diff. Simplest
  correct fix now: keep a module-scoped `Set` of alerted ids, check-and-add
  synchronously, and only toast ids not in it.
- **Coalesce list/thread reloads.** Debounce `loadList`/`loadThread` (e.g.
  150ms trailing) so a burst of WS events causes one refetch, not many. This
  also kills most of the flicker and the duplicate-toast race in one move.
- **Notification drawer.** Render the panel through a portal
  (`createPortal` to `document.body`) positioned relative to the bell button
  via `getBoundingClientRect`, opening upward when the button is in the lower
  half of the viewport. Remove the reliance on the footer not clipping it.
- **Auto-unarchive on inbound.** In `recordInbound`, add
  `archived_at = null` to the conversation `on conflict` update so any new
  message pulls the chat back into the active list. Keep `muted_until` as-is
  (WhatsApp keeps mutes through new messages).
- **Reverse actions on mobile.** Make pin/mute/archive/unarchive reachable on
  mobile: an overflow (`⋮`) menu in the thread header with the full set, and a
  long-press / swipe action on the list row (Phase 2 adds the row gestures).

Suggestions:
- Give every toast a `key` derived from the event so React never mounts two
  identical ones even if the code double-calls.
- Add a global toast de-dupe: if an identical message is already on screen,
  refresh its timer instead of stacking a second copy.

Commit: `Fix duplicate handoff toasts, notification drawer clipping, and auto-unarchive on new message`

---

## Phase 2 — Conversation lifecycle: block, delete, and complete pin/mute/archive (M/L)

Goal: full, reversible control over a chat, exactly like WhatsApp Business.

Findings: pin/mute/archive exist but are half-wired (desktop-only, no row
actions, mute has a fixed 8h only); block/unblock and delete are absent.

Fixes:
- **Block / unblock.** WhatsApp Cloud API exposes a Block API (`POST
  /{phone-number-id}/block_users` and `/unblock_users`). Add:
  - migration: `conversations.blocked_at timestamptz`.
  - `MetaClient.blockUser(waId)` / `unblockUser(waId)`.
  - When blocked: the webhook handler drops inbound from that wa_id before it
    reaches the bot (still stored, but no reply, no drip, no push).
  - UI: block/unblock in the thread overflow menu, with a confirm dialog and a
    clear "Blocked" banner in the thread.
- **Delete chat.** Soft-delete first (`deleted_at`), hidden everywhere, with an
  "undo" toast for 6 seconds; a nightly job hard-deletes rows past 30 days.
  Never expose a raw hard-delete button to the client — it's irreversible and
  they will misclick.
- **Mute options.** Replace the fixed 8h with a small menu: 8 hours, 1 week,
  Always. Store `muted_until` (null = unmuted, far-future = always).
- **Row-level actions.** Swipe on mobile (swipe-left = archive, swipe-right =
  pin), long-press = action sheet. On desktop, a hover `⋮` on the row.
- **Archived list UX.** Show an "Archived (N)" entry at the top of the list
  like WhatsApp, not a filter tab, and let a row be unarchived inline.

Suggestions:
- A "Blocked contacts" admin view listing everyone blocked, with unblock.
- Bulk actions: multi-select rows to archive/mark-read/delete.
- "Mark as unread" to flag a chat for later.

Commit: `Add block, unblock, delete, and complete mute/pin/archive across web and mobile`

---

## Phase 3 — Realtime and data efficiency (M)

Goal: the UI updates from small targeted events, not full refetches, so it's
instant and doesn't flicker under load.

Findings: `realtime.emit` sends coarse events; the client responds by
refetching the entire world (`Console.jsx:370`). `getConversationMessages`
reloads all 200 messages every time.

Fixes:
- **Targeted events.** Have the server emit typed events with payloads:
  `message:new` (conversationId + the message row), `message:status`
  (wamid + status), `conversation:update` (the changed conversation row).
  The client applies these to local state instead of refetching.
- **Incremental thread.** Append a new message to the open thread in place;
  update a status tick in place. Only full-reload on first open.
- **Message pagination.** Load the latest 50 on open, fetch older on
  scroll-up. Add a keyset cursor (`id < ?`) rather than OFFSET.
- **Thread ordering.** Change `getConversationMessages` to order by
  `coalesce(sent_at, created_at), id` for consistency with the list.
- **Single notification poller.** Lift notification state to one place (a
  context/provider) so both bells read one source and one 30s poll; refresh it
  immediately on the `conversation:update` WS event instead of only polling.

Suggestions:
- Optimistic send: render the outbound bubble immediately with a "sending"
  tick, reconcile when the server confirms.
- Debounced "typing…" indicator driven by WhatsApp's typing signals if you
  enable them.

Commit: `Switch realtime to targeted events with incremental UI updates and message pagination`

---

## Phase 4 — Backend performance and database hardening (M)

Goal: fast replies, a pool that won't tip over, and a DB that can't be
corrupted by a bad write or a runaway query.

Findings: no per-reply FAQ cache; O(n²) trim; pool `max: 10`, no statement
timeout; possibly-invalid Gemini model id; sequential pack queries.

Fixes:
- **Fix the model id.** Set `GEMINI_MODEL` to a real, current id and fail fast
  at startup if a test completion 400s, so a bad id never ships silently.
- **Cache FAQ context.** Memoize `buildFaqContext` by the sorted pack-id key
  with a short TTL (30–60s) and bust it on any FAQ write. 100 leads on the same
  pack then build the prompt once. Big latency win, trivial risk.
- **Fix `trimToBudget`.** Compute per-row token counts once, sum them, and drop
  from the tail by arithmetic instead of re-rendering the whole string each
  iteration.
- **Parallelize pack loads.** `buildFaqContext` awaits packs in a loop; run the
  per-pack `listFaqs` with `Promise.all`.
- **Pool + timeouts.** Raise `max` to ~20 (2 vCPU handles it), set
  `statement_timeout` (e.g. 8s) and `idle_in_transaction_session_timeout` on
  the pool so a stuck query can't pin a connection. Add
  `application_name` for observability.
- **Indexes.** Confirm/add: `messages(conversation_id, sent_at)`,
  `conversations(state)` partial, `push_subscriptions(agent_email)`,
  `notifications(agent_email, created_at desc)`. (Several exist from recent
  migrations — audit with `\di` on the VPS.)
- **Constraints for integrity.** Add CHECK constraints
  (`direction in ('inbound','outbound')`, `state in (...)`), NOT NULL where
  implied, and foreign-key `on delete` rules that match the delete/soft-delete
  policy. This is what makes the DB "non-corruptable" — the schema rejects bad
  states.
- **Remove leftover logging.** Drop `console.error` in `sendAndRecord`.

Suggestions:
- Use the 8 GB: set Postgres `shared_buffers≈2GB`, `effective_cache_size≈6GB`,
  `work_mem` tuned; enable `pg_stat_statements` to find slow queries.
- Add a lightweight LRU for `getConversationContext` (per-conversation, tiny
  TTL) since it's read on every reply.
- Precompute and store the rendered FAQ block per pack-set so the AI prompt is
  a string lookup, refreshed on FAQ edits.

Commit: `Cache FAQ context, harden pool with timeouts, add integrity constraints, fix model id`

---

## Phase 5 — Notification system, unified and correct (M)

Goal: one coherent notification model across in-app inbox, web push, and FCM —
no double-fires, accurate badges, and a clean split between "notification
inbox" and "push on/off + test", which is what you asked for.

Findings: inbox and push controls are tangled in the bell/pill; badge only
counts pending; two independent pollers; SW `renotify:true` with per-cid tags.

Fixes:
- **Split the two concepts cleanly** (you asked for this explicitly):
  - **Bell = inbox only.** Opens the drawer (portal, Phase 1). Shows unread
    count, mark-all-read, click-through. Second click closes.
  - **Push control = its own control**, ideally in Settings and as a small
    status chip: On / Off / Blocked, with a "Send test" button that only
    enables when On. Turning Off actually unsubscribes server-side.
- **Accurate unread badge.** Count unread across all chats (pending + unread
  human messages), not just pending. Drive the favicon/title badge and the
  bell from the same number.
- **De-dupe push.** One inbox row + one push per event; the SW already tags per
  conversation — keep `renotify` off unless the tag changed.
- **Single source of truth.** A `NotificationProvider` holds inbox state, does
  one poll, and exposes it to every bell instance.

Suggestions:
- Per-notification-type preferences (handoffs always; inbound-in-takeover
  optional; drips off).
- "Do not disturb" schedule (e.g. mute all push 9pm–8am).
- Desktop notification sound toggle, separate from the in-app chime.

Commit: `Unify notification inbox and push controls with accurate cross-chat unread badge`

---

## Phase 6 — Media pipeline completeness (M)

Goal: every file type a lead can send is viewable and downloadable, audio
notes play inline, and the agent can send images/documents/audio back.

Findings: backend passes all MIME through already; inline preview added for
image/audio/video (Phase-0 work); outbound is text + FAQ-media only; no upload
progress; blurred placeholder for everything else.

Fixes:
- **Confirm no allowlist anywhere** (backend already streams through; audit the
  upload path `api.js:754` for any silent type filter).
- **Outbound media from the composer.** A paperclip that lets the agent send an
  image, document, or audio note; validate against WhatsApp's accepted types
  before upload; show progress.
- **Voice notes.** Inbound `audio/ogg` (OPUS) plays inline; outbound voice via
  the accepted audio types.
- **Real thumbnails.** For images/video, request WhatsApp's thumbnail so the
  list/thread shows a real preview instead of the gradient.
- **Document affordance.** Filename, size, and a proper file-type glyph.

Suggestions:
- Drag-and-drop and paste-to-send on desktop.
- Image lightbox (click to zoom, swipe between a chat's images).
- Caption support on outbound media.

Commit: `Complete media: outbound attachments from composer, inline voice notes, real thumbnails`

---

## Phase 7 — WhatsApp-parity features (L)

Goal: the console *feels* like WhatsApp Business, not a generic admin panel.

Fixes / features (each is small; ship in a batch):
- **Reply / quote.** Click a message → composer shows a quoted block; send with
  WhatsApp's `context.message_id`. Render inbound replies with the quoted
  original.
- **Reactions.** Long-press → emoji reaction (WhatsApp reactions API).
- **Starred messages.** Star a message; a "Starred" view in the sidebar.
- **In-chat search.** Search within a conversation, jump to matches.
- **Date dividers + unread line.** "Today / Yesterday / 12 Aug" sticky pills
  and a "Unread messages" separator on open (partly present — verify).
- **Forward.** Forward a message to another chat.
- **Contact panel.** The details drawer shows wa_id, campaign source, first
  seen, tags, and a nickname (frontend alias already exists).
- **Templates UX.** When the 24h window is closed, guide the agent to a
  template with a clear explanation (never silently fail — you already surface
  131047; make it a friendly inline prompt).

Suggestions:
- Labels/tags on conversations (WhatsApp Business labels) with colour chips and
  filter-by-label.
- Quick replies / canned responses the agent can insert.
- Saved "notes" on a contact, internal-only.

Commit: `Add reply, reactions, starred, in-chat search, forward, and labels`

---

## Phase 8 — UI/UX redesign: clean, sleek, not an "AI palette" (L)

Goal: a restrained, modern, WhatsApp-authentic look on web and mobile.

Findings: accent is WhatsApp green (`#00a884`, good), but recent additions
lean on indigo/amber accents that read as a generic "AI" palette; spacing and
type scale are inconsistent across admin pages; some overflow on mobile.

Fixes:
- **One palette.** WhatsApp-family: teal-green primary, neutral warm grays,
  a single semantic set (green=ok, red=urgent, amber=waiting used sparingly).
  Retire indigo. Define as CSS variables and use everywhere; no ad-hoc hex.
- **Type + spacing scale.** A fixed scale (e.g. 12/14/16/20/24/32) and spacing
  tokens; apply consistently across Console and all admin pages.
- **Component pass.** Buttons, inputs, chips, modals, drawers unified through
  the existing `components/ui/*`; kill one-off styles.
- **Responsive audit.** Every screen at 360px, 390px, 768px, 1280px. Fix all
  horizontal overflow (wrap the known offenders in `overflow-x-auto`).
- **Dark mode.** WhatsApp has it; add a theme toggle with proper tokens.
- **Empty states + skeletons.** Every list/thread has a designed empty state
  and a skeleton while loading (skeleton component exists — apply it).
- **Micro-interactions.** Subtle bubble entry, smooth list reorder, 150ms
  transitions — nothing flashy.

Suggestions:
- A compact/comfortable density toggle.
- Accessibility pass: focus rings, `aria` on all controls, contrast AA.
- Keyboard shortcuts (j/k to move chats, / to search, r to reply).

Commit: `Redesign UI with a unified WhatsApp-authentic palette, type scale, dark mode, and responsive fixes`

---

## Phase 9 — Mobile app (Capacitor) polish (M)

Goal: the APK feels native, not a wrapped website.

Findings: back-button handling and safe-areas are wired; text sizes were
tuned; hosted-URL wrapper is correct.

Fixes:
- **Safe areas everywhere** (notch, home indicator) — audit every fixed bar.
- **Native transitions** for thread open/close (slide), matching WhatsApp.
- **Pull-to-refresh** on the list.
- **Haptics** on send / long-press (Capacitor Haptics).
- **App icon + splash** via `@capacitor/assets`, adaptive icons.
- **Offline state** — a clear banner when the device is offline, queue the
  outbound and flush on reconnect.
- **FCM channel** with sound/importance set so pushes behave on Android 13+.

Suggestions:
- Deep links so a notification opens the exact chat (partly present via `?c=`).
- Biometric lock for the app (FaceID/fingerprint) — client data is sensitive.

Commit: `Polish Android app: safe areas, native transitions, haptics, offline queue, adaptive icons`

---

## Phase 10 — Reliability: never lose a message (M)

Goal: no dropped or duplicated messages, ever, even across restarts and deploys.

Findings: webhook processing runs after 200 (good), dedupes by wa_message_id
(good), but a throw mid-processing loses that message; no dead-letter; no
external uptime check. This is the "message arrived in the evening" class of
bug.

Fixes:
- **Dead-letter table.** Wrap each webhook change in try/catch; on failure,
  store the raw payload + error in `webhook_dead_letter` for manual/automatic
  replay. Nothing is ever silently lost.
- **Idempotency by wa_message_id** is already there — extend the same guard to
  status updates so retries don't double-write.
- **Process supervision.** systemd/PM2 auto-restart; on boot, the migrate +
  webhook-retry path catches up. Document it.
- **Graceful shutdown.** Drain in-flight webhooks and the batcher before exit
  so a deploy doesn't cut a reply mid-send.
- **External uptime monitor** hitting `/health` every minute with alerting.
- **`sent_at` display** is done; verify the thread now shows morning-sent,
  evening-delivered messages in the right place with the right time.

Suggestions:
- A "reconcile" admin action that re-pulls recent message statuses from Meta.
- Structured alerting when handoff push fails for all devices (nobody heard it).

Commit: `Add webhook dead-letter, graceful shutdown, health checks, and status idempotency`

---

## Phase 11 — Security and multi-agent correctness (M)

Goal: safe for a real client and ready for more than one agent.

Findings: only login is rate-limited; WS auth is a token in the query string;
conversation flags are global (fine for a shared inbox, but takeover has no
assignment guard); admin password is a weak default in `.env`.

Fixes:
- **Rotate and strengthen secrets.** The committed-looking `.env` has a live
  FCM key, Meta token, and `ADMIN_PASSWORD=12345678`. Rotate all of them; force
  a strong admin password; confirm `.env` is git-ignored and was never pushed.
- **Rate-limit the API**, not just login (per-token and per-IP).
- **WS auth** via the `Sec-WebSocket-Protocol` header or a short-lived ticket
  instead of a token in the URL (URLs get logged).
- **Assignment.** When an agent takes over, record the assignee; warn if
  another agent is already in the chat; show "X is here" presence.
- **Input validation** on every route body (Fastify schemas) — several routes
  trust `req.body` shape.
- **Audit coverage.** Log block/delete/unblock/handback with actor.

Suggestions:
- Roles (admin vs agent); restrict Setup/Team/Knowledge to admins.
- 2FA for admin login.
- Per-agent notification routing (only the assignee is pinged once assigned).

Commit: `Harden security: API rate limits, WS auth, input validation, rotate secrets, assignment guards`

---

## Phase 12 — Observability and ops (S/M)

Goal: when something breaks in prod, you see it in seconds.

Fixes:
- **Error tracking** (Sentry or similar) on both backend and frontend.
- **Structured request logging** with a request id; log AI latency, Meta
  latency, and DB time per reply so you can see where the milliseconds go.
- **A `/metrics` or admin health panel**: queue depth, WS clients, push
  success rate, last webhook time, AI error rate.
- **Log hygiene**: no secrets, no full message bodies at info level.

Suggestions:
- A daily digest email to theTwoCubes: volume, handoff rate, AI errors,
  slowest queries.
- Feature flags so risky changes can be toggled without a deploy.

Commit: `Add error tracking, per-reply latency logging, and an ops health panel`

---

## Phase 13 — Testing and QA (M/L)

Goal: changes stop breaking things; the suite runs in CI and needs a DB.

Findings: tests exist (`qa/tests/*`) but need a live Postgres and aren't in CI.

Fixes:
- **Spin Postgres in CI** (GitHub Actions service container) so the suite runs
  on every push.
- **Unit tests** for the pure logic: `assemblePacks`, `trimToBudget`,
  `parseDecision`, `keywordPacks`, the batcher.
- **Integration tests** for the webhook → reply → handoff paths, block/delete,
  auto-unarchive, and the notification writes.
- **A tiny e2e** (Playwright) for login → open chat → send → see it.
- **Seed script** for a realistic demo dataset for manual QA.

Suggestions:
- Contract tests against a recorded Meta webhook fixture set.
- The FAQ simulator (`simulator.js`) run nightly over 20 scripted
  conversations as a behaviour regression gate.

Commit: `Add CI with Postgres, unit/integration/e2e coverage for critical paths`

---

## Phase 14 — Deploy, migrations, and rollback discipline (S/M)

Goal: safe, repeatable deploys on the VPS.

Fixes:
- **Migration discipline.** Every schema change is a numbered migration (you're
  doing this); never edit an applied migration; test the up-path on a copy of
  prod.
- **Pre-deploy `pg_dump`** automated into `scripts/backup.sh` (exists — wire it
  to a cron and off-box storage).
- **Zero-downtime-ish deploy**: build, migrate, health-check, then swap.
- **Rollback runbook**: how to revert a bad deploy and restore a dump.
- **`.env` management**: a documented `.env.example` (exists) and a secrets
  checklist; never bake secrets into the image.

Suggestions:
- Dockerized deploy with a compose profile for prod (partly present).
- Staging environment mirroring prod for final checks.

Commit: `Automate backups, document deploy and rollback runbook`

---

## Phase 15 — AI quality, handoff calibration, and latency budget (M)

Goal: the bot handles more on its own, hands off for the right reasons, and
replies fast.

Findings: handoff reason is free text (hard to analyse); no confidence signal;
no per-reply latency budget; greeting handoff already fixed.

Fixes:
- **Handoff reason enum.** Constrain `reason` to a small set
  (`price_negotiation`, `custom_quote`, `complaint`, `personal_meeting`,
  `unknown_service`, `unsure_answer`, `explicit_request`, `attachment`,
  `other`). Then build a "why do we hand off?" admin report so you can see
  which pack is thin and feed it back into the FAQs monthly.
- **Confidence gate.** Add a `confidence` field; log low-confidence answers so
  you can review what the bot *almost* got wrong.
- **Latency budget.** Target p95 < 3s: prompt caching (shared prefix already
  in place), FAQ cache (Phase 4), a fast model id, and a request timeout so a
  hung AI call falls back to a graceful handoff instead of hanging the batch.
- **Cheap greeting fast-path.** For pure greetings/stickers/emojis, reply from
  a canned base-pack line with no model call — zero latency, zero cost.

Suggestions:
- Nightly refinement (`refinement.js`) proposes new FAQs from real handoffs.
- Per-service tone tuning as more packs are added (packaging, website, digital
  marketing, video).
- A/B two prompt variants and compare handoff rate.

Commit: `Calibrate handoff with reason enum and confidence, add latency budget and greeting fast-path`

---

## Suggested execution order

Correctness first, then feel, then scale:

1. Phase 1 (reported bugs) — ship immediately.
2. Phase 2 (lifecycle: block/delete/mute/pin/archive) — the other half of what
   you asked for.
3. Phase 3 (realtime efficiency) — makes everything feel instant.
4. Phase 4 (backend/DB hardening) — latency + integrity.
5. Phase 5 (notifications unified) — closes the notification chapter.
6. Phase 10 (reliability) — before real load, guarantee no lost messages.
7. Phase 6, 7 (media + WhatsApp parity) — the "feels like WhatsApp" jump.
8. Phase 8, 9 (UI redesign + mobile polish) — the visual bar you want.
9. Phase 11, 12 (security + observability) — production safety.
10. Phase 13, 14 (testing + deploy) — keep it from regressing.
11. Phase 15 (AI quality) — ongoing, revisit monthly.

Phases 1–5 and 10 are the "no errors tolerated" core. 6–9 are the client-facing
polish. 11–15 are what keep it healthy in production.

---

## Immediate pre-work (do before Phase 1, unrelated to features)

- **Rotate the secrets** in `.env` (Meta token, FCM service account,
  `ADMIN_PASSWORD`, JWT secret) and confirm the file's git history is clean.
  This is the single highest-risk item in the repo right now.
- **Fix `GEMINI_MODEL`** to a valid id and confirm a live completion succeeds
  on the VPS.
- **Take a `pg_dump`** of prod so every later phase has a restore point.
