# Deployment and handover

The whole system runs on one VPS with Docker Compose: the Node app, PostgreSQL,
and Caddy for HTTPS. The only recurring cost is the VPS. WhatsApp template fees
and the OpenAI key sit on the client accounts.

## What you need first

- A VPS with Docker and the compose plugin installed.
- A domain name with an A record pointing at the VPS IP. Caddy needs it to get
  the HTTPS certificate.
- The `.env` values filled in (see `.env.example`).

## First deploy

1. Copy the project to the server and enter it.
2. Create `.env` from the template and fill it in:

       cp .env.example .env

   For production set at least: the `META_*` values, `WEBHOOK_VERIFY_TOKEN`,
   `OPENAI_API_KEY`, `JWT_SECRET` (a long random string), `ADMIN_EMAIL` and
   `ADMIN_PASSWORD` (the first console login), `DOMAIN`, and a strong
   `POSTGRES_PASSWORD`. In production `DATABASE_URL` is built from the
   `POSTGRES_*` values automatically, so the one in `.env` is ignored there.

3. Build and start everything:

       docker compose -f docker-compose.prod.yml up -d --build

   On boot the app runs the database migrations and seeds the admin login.

4. Check it is up:

       curl -s https://YOUR-DOMAIN/health

5. Generate the Android App (optional):

       Place the `google-services.json` from Firebase in `android/app/`
       Run `./scripts/build-apk.sh` to generate the client APK.

## Configure the webhook in Meta

1. Meta app dashboard, WhatsApp, Configuration.
2. Callback URL: `https://YOUR-DOMAIN/webhook`
3. Verify token: the value of `WEBHOOK_VERIFY_TOKEN` in `.env`.
4. Save, then click Manage next to the webhook fields and tick `messages`.

## Using the console

Open `https://YOUR-DOMAIN/` and sign in with `ADMIN_EMAIL` and `ADMIN_PASSWORD`.
From there you see every chat, take over any of them, hand them back to the bot,
and send approved templates.

## Backups

`scripts/backup.sh` writes a gzipped dump to `backups/` and keeps the last 14.
Run it from cron on the server, for example daily at 2am:

    0 2 * * * cd /path/to/project && ./scripts/backup.sh >> backups/backup.log 2>&1

To actually recover from a backup (overwrites the live database - only for a
real incident):

    gunzip -c backups/FILE.sql.gz | docker compose -f docker-compose.prod.yml exec -T db psql -U whatsapp whatsapp

### Restore drill

A backup nobody has ever restored is a hope, not a plan. `scripts/restore.sh`
restores a dump into a throwaway database (`whatsapp_restore_check` by
default) instead, so checking a backup is actually good never touches the
live one:

    bash scripts/restore.sh backups/FILE.sql.gz

Then spot check a few tables (`select count(*) from contacts;` and the like)
against the live database, and drop the scratch database when done - the
script prints the exact command. Do this after any schema change that
touches backup/restore-sensitive areas, and periodically regardless (monthly
is reasonable) so a real incident is never the first time it's been tried.

## Updating

    git pull
    docker compose -f docker-compose.prod.yml up -d --build

Migrations run automatically on the new container's boot.

## Handover to the client account

Nothing in the code is tied to a specific account, so no code changes are
needed. But the Meta side needs more than swapping `.env` values, and the
steps below are the ones that actually caused silent failures when they were
missed. Do them in order.

1. Put the client's `META_PHONE_NUMBER_ID`, `META_WABA_ID`, `META_ACCESS_TOKEN`
   (a permanent System User token) and `META_APP_SECRET` in `.env`. The app
   secret belongs to the client's *app*, not their WABA - using the wrong one
   makes every inbound fail signature verification with a 401.
2. Point the client's webhook at `https://YOUR-DOMAIN/webhook`, set the verify
   token, and tick `messages`.
3. **Subscribe the app to the WABA.** This is separate from the webhook config
   above and is the one most easily missed: a correctly configured webhook on a
   WABA that is subscribed to no app receives nothing at all.

       curl -X POST "https://graph.facebook.com/v21.0/<WABA_ID>/subscribed_apps" \
         -H "Authorization: Bearer <ACCESS_TOKEN>"

   Verify with a `GET` on the same path. It must list the client's app.
4. **Remove any other app's webhook on that number.** If the number was
   previously on a different app (a BSP like doubletick, or your own test app),
   that subscription keeps intercepting deliveries.
5. **Register the number on Cloud API**, or sends fail even though inbound
   works. Two-factor authentication has to be off first, and the PIN is the
   number's existing 6 digit PIN if it ever had one:

       curl -X POST "https://graph.facebook.com/v21.0/<PHONE_NUMBER_ID>/register" \
         -H "Authorization: Bearer <ACCESS_TOKEN>" \
         -d "messaging_product=whatsapp" -d "pin=<6_DIGIT_PIN>"

   Then re-enable 2FA. Confirm the number reads CONNECTED on CLOUD_API.
6. Set data localization if the client needs in-country storage, via
   `POST /<PHONE_NUMBER_ID>/settings` with the region nested under
   `storage_configuration` (a bare `data_localization_region` is rejected).
7. Add the client's AI keys (see Requirements in README.md for which does what).
8. Load the knowledge base, then sync templates and only then set the drip
   schedule - a step naming a template that is not approved in *this* WABA
   fails at send time.
9. Restart:

       docker compose -f docker-compose.prod.yml up -d

10. Send a real message to the number and confirm it appears in the console,
    then confirm the bot's reply arrives back on the phone. Inbound and
    outbound fail independently, so test both directions explicitly.

## Monitoring and scaling

- `GET /health` is a liveness check, `GET /ready` also checks the database, and
  `GET /metrics` exposes Prometheus style counters. `/metrics` has no auth of
  its own, so `deploy/Caddyfile` blocks it from the public internet by
  default - check it from the VPS itself, or wire a monitoring agent that
  runs alongside the app on the same Docker network.
- The drip scheduler claims jobs atomically with `for update skip locked`, so you
  can run more than one app instance without double sending follow ups. The live
  update websocket is per instance, which is fine for one server; put it behind a
  shared channel if you ever run several.

### Error tracking (optional)

Set `SENTRY_DSN` in `.env` (a free project at sentry.io is enough for one
client) to have unhandled exceptions, 500-level route errors, and webhook
processing failures reported there instead of only living in server logs.
Leave it blank and nothing changes - this is purely additive.

### Uptime monitoring (do this - it's outside the app, so nothing here does it for you)

Nothing currently watches this server from the outside. Set up a free checker
(UptimeRobot, Better Uptime, or similar) against:

- `https://YOUR-DOMAIN/health` every 1-5 minutes - alerts if the process itself
  is down.
- `https://YOUR-DOMAIN/ready` - alerts specifically if the database connection
  is the problem, which `/health` alone won't catch.

Point the alert at whatever you'll actually see quickly (email, SMS, a
WhatsApp number of your own). This needs your own account with the monitoring
service - there's no API key for it to add here.

## Notes

- The app is not exposed directly; Caddy is the only thing on ports 80 and 443
  and proxies to the app over the internal network.
- Use a permanent System User token in production. The dev console tokens expire
  in hours.

## Go-live checklist

Everything above gets the system running. This is the final pass before real
leads hit it - go through it in order, and do not skip an item because it was
already true "last time."

1. **`NODE_ENV=production` is actually set** in the deployed `.env` or compose
   environment. This is what turns off full-payload webhook debug logging (lead
   phone numbers and message text would otherwise be logged in full) and
   pretty-printed dev log output.
2. **Every secret in `.env` on the server is a real production value**, not a
   leftover from testing: `JWT_SECRET` (long random string, never the literal
   string used in dev), `META_APP_SECRET`, `META_ACCESS_TOKEN` (a permanent
   System User token, not a short-lived dev-console one), `POSTGRES_PASSWORD`,
   `ADMIN_PASSWORD`. Confirm by reading the actual deployed `.env`, not by
   assuming it matches what's in `.env.example`.
3. **The number is migrated off doubletick onto the client's own Meta app** -
   this is the actual last go/no-go gate; nothing above technically requires it,
   but going live without it means the console is running against the wrong
   number.
4. **`scripts/backup.sh` is scheduled**, not just present in the repo - confirm
   the cron entry from the Backups section above is actually installed on the
   VPS (`crontab -l`), not only documented.
5. **Run `npm run qa` one final time** against a clean test database after any
   further changes, and confirm all tests pass before deploying.
6. **One manual pass through the golden path** on the real deployed URL, not
   just localhost: log in, open an inbound conversation, send a reply, run a
   small real bulk-send batch to completion, then reload the page and reopen
   Bulk send to confirm the batch is still there. That last step is the direct,
   end-to-end proof that bulk-send progress now survives a reload in the real
   deployment, not just in dev.
7. **Known accepted risk, not blocking**: `npm audit` on the repo root reports
   findings up to critical severity (currently `tar` and `sharp`, transitive
   through `@capacitor/assets`), all marked "No fix available" upstream. Every
   one of them is in the Android icon/APK build tooling, which lives in
   `devDependencies` and never runs against untrusted input. What actually
   serves traffic is what CI gates on:

       npm audit --omit=dev --audit-level=high

   That is the number to care about, and it must be clean before a deploy.
   `npm audit fix --force` was tried in a hardening pass and made things worse
   - do not force-upgrade these without a dedicated maintenance window and its
   own full test cycle.
8. **Known limitation, not blocking at current scale**: rate limiters (login,
   write, global API) are in-process memory, not shared. Fine for the current
   single-app-container deployment; if the app is ever scaled to more than one
   instance, revisit this (or accept weaker effective limits).

Once every item above is checked, the product is production-ready by this
audit's standard.
