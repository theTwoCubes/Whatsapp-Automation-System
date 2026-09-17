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

Restore a dump with:

    gunzip -c backups/FILE.sql.gz | docker compose -f docker-compose.prod.yml exec -T db psql -U whatsapp whatsapp

## Updating

    git pull
    docker compose -f docker-compose.prod.yml up -d --build

Migrations run automatically on the new container's boot.

## Handover to the client account

The system is env driven, so moving from the test setup to the client account is
a matter of swapping values in `.env` and restarting:

1. Put the client's `META_PHONE_NUMBER_ID`, `META_WABA_ID`, `META_ACCESS_TOKEN`
   (a permanent System User token) and `META_APP_SECRET` in `.env`.
2. Point the client's webhook at `https://YOUR-DOMAIN/webhook` and tick
   `messages`.
3. Add the client's `OPENAI_API_KEY`.
4. Load the knowledge base and the approved template names.
5. Restart:

       docker compose -f docker-compose.prod.yml up -d

Nothing in the code is tied to a specific account, so no code changes are needed.

## Monitoring and scaling

- `GET /health` is a liveness check, `GET /ready` also checks the database, and
  `GET /metrics` exposes Prometheus style counters. Restrict `/metrics` at Caddy
  if you do not want the counts public.
- The drip scheduler claims jobs atomically with `for update skip locked`, so you
  can run more than one app instance without double sending follow ups. The live
  update websocket is per instance, which is fine for one server; put it behind a
  shared channel if you ever run several.

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
7. **Known accepted risk, not blocking**: `npm audit` on the repo root reports 9
   moderate-severity findings, all transitive through `@capacitor/cli` and
   `firebase-admin` (mobile build tooling, not runtime/request-path code).
   `npm audit fix --force` was tried in a hardening pass and made things worse
   (introduced a critical and 3 high findings elsewhere) - do not force-upgrade
   these without a dedicated maintenance window and its own full test cycle.
8. **Known limitation, not blocking at current scale**: rate limiters (login,
   write, global API) are in-process memory, not shared. Fine for the current
   single-app-container deployment; if the app is ever scaled to more than one
   instance, revisit this (or accept weaker effective limits).

Once every item above is checked, the product is production-ready by this
audit's standard.
