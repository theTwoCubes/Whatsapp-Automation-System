# Production punch list — WhatsApp Automation console

Owner intent: ship this as a small, focused, production-grade tool for one
client (AdVoice Inc., Ahmedabad). Not a consumer product, not a platform. It
runs as a hosted web console, a PWA installable on Android/iOS, and a
sideloaded Android APK produced by `npm run apk` (Capacitor wrapper around the
same hosted URL).

The stack works end to end today. This document is the punch list that gets it
to feel finished on a phone and to make the notification path visible and
trustworthy. Every item below is a discrete change with a file, a reason, an
acceptance test, and an anti-goal so a fresh agent can execute it without
re-deriving context.

Read this whole file before opening any editor. The sequence matters — some
of the "smoothness" fixes only look right after the layout fixes land.

---

## 0. Non-negotiable ground rules for whoever picks this up

These have been repeated across the project and burn cycles if missed:

- **Look human-authored.** No AI-style banners, no em dashes (`—`) in prose
  the user sees, no verbose "AI generated" fingerprints in commits or copy.
  Match the surrounding tone of [Console.jsx](../web/src/Console.jsx) and
  [App.jsx](../web/src/App.jsx).
- **Do not touch these files unless the fix explicitly says so:**
  - [web/src/components/ui/Toast.jsx](../web/src/components/ui/Toast.jsx) — user owns this design; only extend, never restyle.
  - [capacitor.config.json](../capacitor.config.json) `server.url` — points at
    a live ngrok/hosted URL. Do not rewrite to a placeholder.
- **Preview is a shared resource.** The user runs their own dev server on
  port 3000. Never call `preview_start` on `whatsapp-server`. If a change is
  observable in a browser, describe the verification path in words, don't
  spin up a competing server.
- **Backend restart required for route changes.** The user runs `node
  src/index.js` themselves; when adding or renaming any Fastify route, the
  message to them must include the restart step.
- **Commits: no `Co-Authored-By` trailer, no AI attribution.** One-line
  imperative subject in lower case, matching git log.
- **Do not work around WhatsApp's 24-hour window.** Error 131047 means the
  window closed — surface it, don't retry silently.

---

## 1. Current state snapshot

### What works
- FAQ pack system, pack expansion, media-as-FAQ attachments, weekly
  refinement/proposals — all shipped in P10–P15.
- Console: real-time list via WebSocket, chat thread, ticks (`sent /
  delivered / read` with the user's chosen colouring), media download of
  inbound attachments to the agent's device (no VPS storage).
- Foreground handoff signals: chime, favicon badge, `(N)` title prefix,
  toast on newly-pending — in [web/src/notifications.js](../web/src/notifications.js).
- Web push infrastructure: [src/push.js](../src/push.js), migration
  [018_push_subscriptions.sql](../src/db/migrations/018_push_subscriptions.sql),
  routes `GET /api/push/vapid-public-key`, `POST /api/push/subscribe`,
  `POST /api/push/unsubscribe`, fanout at all three handoff sites in
  [src/handlers/message.js](../src/handlers/message.js).
- PWA: [manifest.webmanifest](../web/public/manifest.webmanifest),
  [service-worker.js](../web/public/service-worker.js), theme-color and
  apple-touch-icon in [index.html](../web/index.html).
- APK pipeline: `npm run apk` → [scripts/build-apk.sh](../scripts/build-apk.sh)
  → `build/console-latest.apk`. Capacitor wrapper points at hosted URL, so
  most content updates do not require rebuilding the APK.

### What is broken or unfinished (the reason for this document)
- **Notifications are not arriving on the client's device**, even after
  "Turn on" is clicked. Root cause unknown — needs an in-console diagnostic.
- **The amber "Turn on notifications" banner never goes away**, because
  `pushState` is derived from `Notification.permission` on mount only, and
  after the user clicks Turn on the state can update but the "dismissed"
  branch is a local UI state that isn't persisted, so it reappears on next
  load.
- **No way to see if push is on or off** without re-triggering the flow —
  should be a visible pill in the top bar / sidebar.
- **The mobile top bar clashes** with the notifications banner and, inside
  a chat, with the thread header. Two stacked headers, cramped vertical
  space on 375-wide screens.
- **UX is jerky** in several small places — scroll jumps on message
  arrival, no scroll-restoration between list and thread on mobile, no
  reconnect indicator on WebSocket drop, buttons flash-highlight on tap.
- **Minor overflows remain** on admin pages and inside the chat header
  when both `wa_id` and a long `assignee` email are present.

The rest of this document is the punch list.

---

## 2. Notification UX (highest priority)

### 2.1 Persist the banner-dismissed state
**File:** [web/src/App.jsx](../web/src/App.jsx)
**Problem:** `pushState` initialises from `Notification.permission` and is
mutated only in-memory. "Not now" hides the banner for the session; a page
reload brings it back. "Turn on" also does not always update the state
because it awaits an async subscribe.

**Fix:**
- On mount, resolve initial `pushState` as the *max* of
  `Notification.permission` and a `localStorage` key
  `wa_push_state`. Values: `'default' | 'granted' | 'denied' | 'dismissed'`.
- When the user clicks **Turn on** and `enablePush()` resolves ok, set both
  React state and `localStorage.wa_push_state = 'granted'`. On failure with
  `denied`, persist `'denied'`. On `default`/other, keep `'default'`.
- When the user clicks **Not now**, set `'dismissed'` and persist.
- On login (already the effect trigger), re-check `Notification.permission`
  and if it moved to `'granted'` in another tab or the OS settings, update
  the store immediately.
- Add a listener on `navigator.permissions.query({name:'notifications'})`
  `.onchange` so revoking permission in the browser flips the pill to red
  without a reload. Wrap in `try/catch`; some browsers do not implement
  `permissions.query` for notifications yet.

**Acceptance:** click Turn on and grant → banner disappears immediately →
reload the page → banner does not come back. Click Not now → banner gone
→ reload → still gone. Change to denied in browser settings → status pill
turns red within one tick.

**Anti-goal:** do not add a cookie. Everything is per-device, per-browser.

### 2.2 Status pill in the top bar
**Files:** [web/src/App.jsx](../web/src/App.jsx),
[web/src/components/layout/Sidebar.jsx](../web/src/components/layout/Sidebar.jsx)

**Problem:** No way to see whether push is on. User has to re-open the
banner to check.

**Fix:** Add a small, always-visible pill:
- Position on desktop: inside the sidebar footer next to the agent email.
- Position on mobile: on the right of the mobile top bar, left of the
  hamburger.
- Visual: a bell icon in a rounded chip. Colours:
  - `granted` → accent green background, `Bell` icon
  - `default` / `dismissed` → gray background, `BellOff` icon, tap opens
    the banner or the permission prompt directly
  - `denied` → red-tinted background, `BellOff` icon, tap opens a modal
    explaining "You blocked notifications for this site. To re-enable, open
    your browser's site settings for this URL."
- On mobile, tapping the pill also lets the agent send a *test push* to
  themselves — hits `POST /api/push/test` (new endpoint, see 2.4).

**Acceptance:** the pill is visible from every screen when signed in; its
colour matches the underlying `Notification.permission`; tapping it does
the sensible thing per state.

### 2.3 The banner and top bar must not stack awkwardly on mobile
**Files:** [web/src/App.jsx](../web/src/App.jsx) (the "Turn on" banner and
the mobile header)

**Problem:** On mobile you now see: mobile top bar (with brand name +
hamburger) → notifications banner → chat thread header. That is three
horizontal strips stacked before any chat content, on a 640-tall device.
Also the banner uses `flex items-center` with `<Bell/>` + long copy +
`Turn on` + `Not now`, which wraps ugly on 375px.

**Fix (two changes together, neither alone is enough):**
1. **Merge the banner and the mobile top bar visually.** When the banner
   is showing on mobile only:
   - Suppress the standalone mobile top bar's own `border-b`.
   - Give the banner a small down-arrow / disclosure so it feels attached.
   - Reduce the banner to icon + one-line copy ("Get alerted when a lead
     needs a person") + a single `Turn on` button; drop `Not now` on
     mobile and instead close by tapping the ✕ that already exists on
     desktop.
2. **Move the banner below the mobile top bar with `border-t-0`** so the
   two share a single visual container. Give the whole shell a max
   header-stack height budget of `72px + 44px = 116px`. If either
   individual component grows, it must shrink somewhere else.

Additionally: on iOS Safari and installed PWAs, respect the safe-area
insets — wrap the top bar and banner in `pt-[env(safe-area-inset-top)]`
via a parent div. Add `viewport-fit=cover` to `<meta viewport>` (already
done) and confirm content is not obscured by the status bar.

**Acceptance:** on a 375×667 device (iPhone SE), signed-in with the
banner showing, everything above the first message bubble takes
≤ 130 pixels. On a 414×896 device (iPhone 11), same rule holds. Rotating
to landscape does not double-stack.

### 2.4 Diagnostic endpoint + button — figure out why pushes aren't arriving
**Files:** [src/routes/api.js](../src/routes/api.js),
[src/push.js](../src/push.js), [web/src/App.jsx](../web/src/App.jsx)

**Problem:** User reports "no notifications received." Root cause could be
any of:
- VAPID keys not set in `.env` (silent no-op in `notifyAgentsOfHandoff`).
- No subscription rows for the signed-in agent.
- Subscription rows exist but for a different email (agent switched
  identity in localStorage but subscription is stale).
- OS-level notification permission for the browser is off.
- Service worker did not update (cache) and old build has no `push`
  listener.
- Client's browser (Brave, DuckDuckGo, some Chinese Android skins) blocks
  push silently.

Without a diagnostic, we're guessing.

**Fix:**
1. `GET /api/push/status` (auth required) returns:
   ```json
   {
     "vapidConfigured": true,
     "myEndpoints": [
       { "id": 12, "transport": "web", "platform": "web",
         "endpointHost": "fcm.googleapis.com",
         "createdAt": "…", "lastSeenAt": "…" }
     ],
     "totalSubscriptions": 3
   }
   ```
   The `endpointHost` (never the full endpoint URL) is enough to know
   whether Chrome (`fcm.googleapis.com`), Firefox (`updates.push.services.mozilla.com`),
   or Safari (`web.push.apple.com`) is registered.

2. `POST /api/push/test` (auth required) — fans out one push with
   `title: 'Test notification', body: 'If you see this, push is working.'`
   to *only the calling agent's* subscriptions, and returns
   `{ok: true, sent: 3, errors: []}` with any per-endpoint failure
   reasons. Reuse `notifyAgentsOfHandoff`'s error handling but filter
   the rows by `agent_email`.

3. In the frontend, wire the status pill tap on mobile and a small
   "Send test" button in the desktop sidebar to call
   `api.pushStatus()` + `api.pushTest()` and show the result in a toast
   ("Sent to 2 devices" or "Server has no subscription for you yet —
   try turning notifications on again.").

**Acceptance:** with the backend running and no keys, tapping Send test
returns a clear "Notifications are not configured on the server — run
`node scripts/generate-vapid.js >> .env` and restart." with no crash.
With keys set and a subscription in place, tapping Send test produces
an OS notification on that device.

### 2.5 Service worker must update reliably
**File:** [web/public/service-worker.js](../web/public/service-worker.js)

**Problem:** When we ship a new SW (add features, fix a bug), browsers
keep the old one until the tab is closed everywhere. If the old SW has
a bug, users are stuck.

**Fix:**
- Add a `const VERSION = 'sw-2026-08-30-1';` at the top and log it in
  `install` and `activate`.
- Call `self.skipWaiting()` in `install` (already there).
- Call `self.clients.claim()` in `activate` (already there).
- After registration in [web/src/push.js](../web/src/push.js), listen
  for `registration.waiting` and prompt the user via toast "A new
  version is ready — reload to update" with a button that does
  `waiting.postMessage({type:'SKIP_WAITING'})` then `location.reload()`.
- Handle `message` in the SW: on `SKIP_WAITING`, call `self.skipWaiting()`
  (redundant but idiomatic).
- Bump the version string on every release so it's easy to see which
  agent is on which build via `chrome://serviceworker-internals`.

**Acceptance:** deploy a new version → open a tab that already had the
site → within seconds, a toast offers to update → tap update → reload
→ new build active.

### 2.6 Notification click behaviour (product decision)
**File:** [web/public/service-worker.js](../web/public/service-worker.js)

**Current spec:** clicking dismisses only. Do not change this without the
user asking. However, add `data: { conversationId }` to the payload
(already emitted from server) and store it on the notification so *if*
they later change their mind, focusing the right tab is a five-line
addition.

---

## 3. Mobile responsiveness — remaining overflows

Do all of these in one pass. Test each on a 360-wide viewport (Chrome
DevTools "iPhone SE" preset, 320px if you can).

### 3.1 Chat thread header
**File:** [web/src/Console.jsx](../web/src/Console.jsx)

- `wa_id` + assignee row: already has `min-w-0` and `truncate` but the
  `<ChevronRight>` between them does not shrink; wrap it in a
  `flex-shrink-0` span (already done). Verify by giving the assignee a
  40-character email and checking with DevTools.
- Action buttons cluster: `Give back to AI` / `Take over` labels are too
  long on 320px. Below `sm`, replace text with an icon-only variant
  (`Bot` / `UserRound`) with a `title` for a11y. Keep desktop labels.
- The `w-px h-8 mx-1` divider between action buttons and the
  panel-toggle button is `hidden md:block` (done) — leave as is.

### 3.2 Composer (`window_open` state)
**File:** [web/src/Console.jsx](../web/src/Console.jsx)

- Two icon buttons + one Send button + input on a 320px screen still
  wraps when the input has ~10 characters. Solutions in order of
  preference:
  1. Hide the `Templates` icon behind an overflow (`⋯`) menu on
     `< sm`. The most common action is Send; keep Paperclip and Send
     always visible.
  2. Reduce icon button size to `w-9 h-9` (36px) on `<sm`.
- The closed-window state (`window_open === false`) already stacks
  vertically on `<sm`. Verify with `window_expires_at` in the past.

### 3.3 Message bubble edge cases
**File:** [web/src/Console.jsx](../web/src/Console.jsx)

- A URL longer than `max-w-[85%]` still needs `break-all` (currently
  `break-words`). Change to
  `break-words [overflow-wrap:anywhere]`.
- Attachment card inside a bubble: cap the outer bubble at `max-w-[85%]`
  and the card at `max-w-[280px]` (done), but the card's inner filename
  needs `truncate` when the filename is a UUID string with no spaces.
- Ticks span at the bottom of an outbound bubble overlaps with the
  message text on short bubbles ("ok"). Give the message text
  `pr-14` if outbound so the tick strip has its own gutter.

### 3.4 Sidebar (mobile drawer)
**File:** [web/src/components/layout/Sidebar.jsx](../web/src/components/layout/Sidebar.jsx)

- The drawer width on mobile is fine, but the nav item labels use
  `text-base`. Reduce to `text-sm md:text-base` on mobile so the
  pending badge doesn't collide with long labels ("Team & Access").
- Add a safe-area padding on the top and bottom:
  `pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]`.

### 3.5 Admin pages — every page, every card
**Files:** all in `web/src/views/admin/`

- **Knowledge → Media pane**: the topic filter row (pills) does not scroll
  on mobile. Add `overflow-x-auto` and `flex-nowrap` + inner pills with
  `flex-shrink-0 whitespace-nowrap`.
- **Knowledge → FAQ row expanded state**: `View history` button and the
  answer text are fine, but the version list row (`px-5 py-4`) needs
  `px-4 md:px-5`. `Restore` button on the right can push on narrow
  screens; wrap the row with `flex-wrap` at `<sm`.
- **Followups → Templates list**: category badge + body italic caption
  can push. Give the caption `truncate` and add `min-w-0` on the outer
  flex.
- **Setup → BusinessProfile**: `Websites` input takes a comma-separated
  string. On mobile, use `textarea` or a chip UI. Minimal fix: switch to
  `textarea` with `rows={2}` — same data shape, no code changes elsewhere.
- **TeamAccess → SideTabs**: on mobile, the side tabs (`w-full md:w-[260px]`)
  become full-width but each tab is 3 rows tall. Compress to one row on
  `<md` (icon + title on one line, description hidden below md).
- **TeamAccess → AuditLog**: the group header (Today / Yesterday) uses
  `bg-gray-50/90 backdrop-blur-sm` sticky. On mobile, the actor pill +
  timestamp + detail row wraps to 3 lines. Give the row `flex-wrap` and
  keep only actor + timestamp on the first line, detail on its own line.

**Recipe for finding more:** Chrome DevTools → device mode → 320px
width → scroll every page, look at `document.body.scrollWidth`. If it
exceeds `window.innerWidth`, something overflows. Bisect by adding
`* { outline: 1px solid red }` temporarily.

### 3.6 Global — prevent the whole page ever scrolling horizontally
**File:** [web/src/styles.css](../web/src/styles.css)

Add:
```css
html, body { overflow-x: clip; }
```

This is a defensive belt on top of per-component `min-w-0` and
`truncate`. `clip` (not `hidden`) is preferred because it does not
create a scroll container that traps sticky elements.

---

## 4. UX smoothness

These are the little details that separate "it works" from "it feels
right." All of them are five-line changes, but they compound.

### 4.1 Scroll restoration between list and thread on mobile
**File:** [web/src/Console.jsx](../web/src/Console.jsx)

- On mobile, tapping a conversation replaces the list with the thread
  (already). Tapping "Back" returns to the list but starts at the top.
  Save the list's `scrollTop` in a ref before switching to a thread,
  restore it after `setSelected(null)`.

### 4.2 Scroll to bottom on new message, but only if already near the bottom
**File:** [web/src/Console.jsx](../web/src/Console.jsx)

Current: `endRef.current?.scrollIntoView({ block: 'end' })` on every
`messages.length` change. If the agent scrolled up to read history and a
new inbound arrives, the view jumps to the bottom — losing their place.

**Fix:**
- Track `wasNearBottom` before render. If distance from bottom < 100px,
  auto-scroll after the render. Otherwise, show a small floating "New
  message ↓" button anchored bottom-center that scrolls on tap.

### 4.3 WebSocket reconnect indicator
**File:** [web/src/Console.jsx](../web/src/Console.jsx)

- The WS silently reconnects on drop, but the agent has no signal that
  the app is temporarily offline. Add a small yellow strip at the top
  of the messages pane: "Reconnecting…" that appears when the WS
  `onclose` fires and disappears on `onopen`. Auto-retry with backoff
  (1s, 2s, 4s, 8s, cap 30s).

### 4.4 Tap highlight on mobile
**File:** [web/src/styles.css](../web/src/styles.css)

Safari and Chrome on Android draw a translucent grey rectangle on tap.
Kill it globally:
```css
* { -webkit-tap-highlight-color: transparent; }
```
Add proper `:active` states (opacity 0.7 for 120ms) on interactive
elements so tactile feedback is intentional, not accidental.

### 4.5 Focus rings on keyboard-only navigation
**File:** [web/src/styles.css](../web/src/styles.css)

Currently all elements get a focus ring on click. Use `:focus-visible`
so only keyboard focus draws a ring. Almost all lucide buttons will
need this pattern:
```css
button:focus { outline: none; }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
```

### 4.6 Loading / empty / error states
Every fetch should have three states, not two. Audit:
- [Console.jsx](../web/src/Console.jsx) `loadThread` catches silently
  (`catch { /* retry */ }`). If the fetch 500s, the thread just stays
  blank. Show an inline "Could not load this conversation" with a
  retry button.
- Admin pages already have skeletons for the list; add error state
  ("Could not load — retry?") with a button.

### 4.7 Toast queue behaviour
**File:** [web/src/components/ui/Toast.jsx](../web/src/components/ui/Toast.jsx)
— *user owns this component; do not restyle, only extend if needed.*

If a burst of handoffs arrives, we call `toast.warning(...)` in a
loop. Currently they stack visually and can be > 5 at once. Cap the
render at 3 most-recent and show `+N more` on top. Keep the queue in
`toasts` array but only render `toasts.slice(-3)`.

### 4.8 Chat area animations
**File:** [web/src/Console.jsx](../web/src/Console.jsx)

- New incoming message: fade in bubble (150ms).
- Bubble sent: slide up 4px + fade in.
- Use CSS keyframes, not JS.

### 4.9 iOS-specific
- Prevent input zoom on focus: any `<input>` and `<textarea>` needs
  `font-size: 16px` minimum on iOS. Our `.field-input` uses `text-sm`
  (14px) — override on mobile: `@media (max-width: 640px) { .field-input,
  .field-textarea { font-size: 16px; } }`. Or set `text-base` on inputs
  and adjust padding.

---

## 5. Push delivery — why nothing arrives (diagnosis path)

Follow this in order, don't skip. If the diagnostic endpoint from 2.4
is not built yet, do it first — it makes this five minutes instead of
an hour.

1. **Server side, keys present?**
   ```bash
   grep VAPID .env
   ```
   Both `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` must be non-empty.
   If missing: `node scripts/generate-vapid.js >> .env`, then restart
   backend.

2. **Server side, `push_configured` returning true?**
   `GET /api/push/vapid-public-key` — response body should have a
   64-char base64url `key`, not `null`.

3. **Backend restart after adding routes?**
   Any time `src/routes/api.js` or `src/push.js` changes, kill and
   restart node. Fastify does not hot-reload routes.

4. **Frontend, service worker registered?**
   In DevTools → Application → Service workers, `service-worker.js`
   should show `activated and is running`. If it shows `redundant`,
   click Unregister and reload. This is a common failure after a
   deploy that changed the SW file.

5. **Frontend, permission granted?**
   In DevTools → Application → Notifications, permission should read
   `granted` for the site's origin.

6. **Server side, subscription row exists?**
   `psql` → `select id, agent_email, transport, endpoint from push_subscriptions;`
   If the row is missing, the frontend `enablePush()` did not POST
   to `/api/push/subscribe`. Common cause: fetch failed because auth
   token was invalid. Check DevTools → Network.

7. **Send test push:** `POST /api/push/test` (with the diagnostic
   from 2.4). Look at the response `errors[]` — if it says `410 Gone`,
   the endpoint expired and the row will be auto-cleaned. If it says
   `403 Forbidden`, VAPID keys mismatch (regenerate + rerun subscribe
   from every device).

8. **Trigger a real handoff:** send `human` from a test WhatsApp
   number. Backend log should say `queued conversation for a human on
   request`. Immediately after, another log entry from `notifyAgentsOfHandoff`
   should say `web push sent` for each row. If it says nothing, the
   handler catch is swallowing an error — add a `log.error` in the
   catch temporarily.

**Common gotcha:** ngrok URL changes on restart of the free plan.
The SW installed under the old URL is not the same origin as the new
URL, so its subscription is stale. If the ngrok URL changed since the
subscription was created, wipe the row and re-subscribe. Long-term
fix: use a static tunnel (`ngrok --domain=<your-reserved-domain>`) or
a real VPS.

---

## 6. Capacitor APK path

### 6.1 What's already in place
- [scripts/build-apk.sh](../scripts/build-apk.sh) does web build → cap
  sync → gradle assembleDebug → copies APK to `build/`.
- Sanity checks for Java and Android SDK with actionable messages.
- npm alias: `npm run apk`.

### 6.2 What is still missing

1. **google-services.json** — FCM does not work without a Firebase
   project. Steps:
   - Create free project at <https://console.firebase.google.com>.
   - Add Android app with app id `com.thetwocubes.console`.
   - Download `google-services.json`; drop it in `android/app/`.
   - Do **not** commit it.
   - Extend [src/push.js](../src/push.js) to send to FCM for rows with
     `transport = 'fcm'` using `firebase-admin` or a raw POST to
     `https://fcm.googleapis.com/v1/projects/<id>/messages:send` with
     the service-account bearer token.
   - Add `FCM_PROJECT_ID` and either `FCM_SERVICE_ACCOUNT_JSON` (base64)
     or path in `.env.example`.

2. **APK signing for release** — currently `assembleDebug` produces an
   unsigned-debug APK. Fine for sideloading during testing, but a
   proper release build should be signed with a real keystore. Add a
   `--release` flag to `build-apk.sh` that runs `assembleRelease` and
   signs with a keystore path from env.

3. **Version bumping** — the AndroidManifest `versionCode` and
   `versionName` don't increment automatically. Add a step in
   `build-apk.sh` that reads the top-level `package.json` version and
   patches `android/app/build.gradle`. Otherwise the client's Android
   won't offer to update — same versionCode is treated as no-op.

4. **In-app status/version display** — show the app version somewhere
   (Setup page footer, or the sidebar footer) so the client can tell
   support "I'm on version 0.2.3" without diagnostic tools. Bake the
   git SHA and build timestamp into a `web/src/build-info.js` via a
   Vite `define` in `vite.config.js`.

5. **Deep-link behaviour** — currently a notification click dismisses.
   That's the product spec. But when the client opens the app from
   the launcher, they land on `/` — which is the console list. Fine.
   Later, if you want notification-click to jump to a chat, add
   `event.waitUntil(clients.openWindow(url))` in the SW's
   `notificationclick` and pass `conversationId` from the payload.

---

## 7. VPS + deployment

Not code, but a checklist so this document is self-sufficient.

- **VPS:** DigitalOcean Bangalore droplet, 2 vCPU / 2 GB / 60 GB — $12/mo.
  Latency to Ahmedabad ~30ms.
- **Runtime:** Node 20+, Postgres 15+, Caddy in front for TLS.
- **Domain:** register a real domain (e.g. `console.advoice.in`), point
  A record to droplet IP, Caddy will auto-provision Let's Encrypt.
- **Process manager:** `pm2 start src/index.js --name wa-console` (or
  systemd — simpler). Log to `/var/log/wa-console/` with rotation.
- **Backups:** daily `pg_dump` to a bucket. DigitalOcean managed
  snapshots as belt.
- **Env file:** never committed. Keep a copy in a password manager and
  in the deploy pipeline.
- **Ngrok replacement:** for local dev with a stable URL, use `cloudflared
  tunnel` or a paid ngrok reserved domain — otherwise the APK breaks
  whenever the URL changes.

---

## 8. Testing matrix

For anything from sections 2–4, verify on:

| Device | Viewport | Browser | Notification |
|---|---|---|---|
| iPhone SE (real or DevTools) | 375×667 | Safari 16.4+ (installed PWA) | ✓ if installed |
| iPhone 12+ | 390×844 | Safari (in-tab) | ✗ (must install) |
| Pixel 5-class Android | 393×851 | Chrome | ✓ |
| Pixel 5-class Android | 393×851 | Installed APK | ✓ (via FCM) |
| Desktop | 1440×900 | Chrome | ✓ |
| Desktop | 1440×900 | Firefox | ✓ |

For every UI fix in section 3, take a screenshot before and after in
DevTools at 320px, 375px, and 768px widths.

---

## 9. Order of operations

Do them in this sequence to avoid rework:

1. **Section 3 (overflow fixes)** — foundation. Everything else layers on top.
2. **Section 2.1 + 2.3** — persist banner state, fix top-bar clash.
   These are cosmetic but block user's ability to test the rest.
3. **Section 2.4** — diagnostic endpoint. Without this, notification
   debugging is guesswork.
4. **Section 5 (walk the diagnosis path)** — actually get one push
   through end to end.
5. **Section 2.2 (status pill)** — now that push works, expose the
   state persistently.
6. **Section 2.5 (SW versioning)** — ship future updates cleanly.
7. **Section 4 (smoothness)** — polish. Nothing here blocks anything;
   pick and choose.
8. **Section 6 (Capacitor / FCM)** — only when the browser path is
   rock solid.

---

## 10. What "done" looks like

- Fresh install on the client's phone, sideloaded APK.
- Client sends `human` from any lead's WhatsApp — within 3 seconds an
  OS-level notification pops up on the client's phone with the lead's
  name and the reason. Tapping dismisses.
- Same event: an OS notification pops up on the client's laptop even
  if the browser tab is closed.
- The console top bar shows a green bell on both devices, so the
  client knows push is on without asking.
- Everywhere in the app on a 375px screen: nothing horizontal scrolls,
  no text overflows a container, no two headers stack awkwardly.
- Running `npm run apk` produces a fresh APK with a bumped version
  code, so the client's phone offers to install it as an update.

Ship that and this is production-grade for one client.
