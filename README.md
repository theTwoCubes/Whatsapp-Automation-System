# WhatsApp AI Lead Agent

A WhatsApp assistant for a design studio. Leads arrive from Click-to-WhatsApp
ads, an AI bot answers questions from a knowledge base you maintain, sends
sample artwork, and runs a day 3 / 5 / 8 follow-up sequence. A human can take
over any chat from a phone and hand it back.

The whole system runs on one server with `docker compose up`.

## What is in the box

- Chatwoot: the shared inbox, on web and on the iOS and Android apps.
- n8n: the automation engine that runs the AI replies and the drip sequence.
- Postgres: stores leads, campaigns, drip state, and media IDs.
- Redis: required by Chatwoot.
- Caddy: reverse proxy with automatic HTTPS.

## Pieces you own

You own every account and credential. The builder never holds your card or a
personal login that, once removed, breaks the system. See HANDOVER.md.

- A domain, with two subdomains pointing at the server (for example
  `chat.yourdomain.com` and `flow.yourdomain.com`).
- A Meta app with WhatsApp, a WhatsApp Business Account, and a registered number.
- An OpenAI API key.
- A Google Sheet for the knowledge base.

## Requirements

- A Linux server with at least 4 GB RAM, 2 vCPU, 40 GB disk. Chatwoot is the
  memory-hungry part.
- Docker and the Docker Compose plugin installed.
- Two DNS A records pointing at the server's public IP, set before first start,
  or Caddy cannot get certificates.

## Setup from a bare server

### 1. Install Docker

Follow Docker's official install for your Linux distribution, then confirm:

```bash
docker --version
docker compose version
```

### 2. Get the code and configure

```bash
git clone <your repo url> whatsapp-agent
cd whatsapp-agent
cp .env.example .env
```

Open `.env` and fill in every value. Notes on the trickier ones:

- `CHATWOOT_SECRET_KEY_BASE`: generate with `openssl rand -hex 64`.
- `N8N_ENCRYPTION_KEY`: generate with `openssl rand -hex 24`.
- `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `N8N_BASIC_AUTH_PASSWORD`: pick strong values.
- The WhatsApp and Chatwoot API values come later, after the manual Meta steps
  and the first Chatwoot login. Leave them blank for now and come back.

Point `APP_DATABASE_URL` at the app database, for example
`postgresql://postgres:YOURPASSWORD@postgres:5432/app`.

### 3. Set DNS

Create two A records, one per subdomain, both pointing at the server IP. Put the
same hostnames in `.env` (`CHATWOOT_HOST`, `N8N_HOST`) and in `FRONTEND_URL`,
`WEBHOOK_URL`, `CHATWOOT_BASE_URL`.

### 4. Start the stack

```bash
docker compose up -d
```

The database schema in `db/` is applied automatically on the first boot of an
empty Postgres volume. Caddy will request certificates on first start; give it a
minute. Then open:

- `https://chat.yourdomain.com` for Chatwoot
- `https://flow.yourdomain.com` for n8n

Create the Chatwoot admin account and the n8n owner account on first visit.

Phase check: you should be able to log into both from your phone browser.

### 5. Manual Meta steps

These happen in Meta's web UI and cannot be automated. Full detail is in
`scripts/register_number.md`. In short:

1. Register the phone number on the Cloud API.
2. Create a System User owned by your business, assign the WABA, and generate a
   permanent token with `whatsapp_business_messaging` and
   `whatsapp_business_management`. Use this token, not a personal one.
3. Add a payment method yourself, on your own card.
4. Submit the three drip templates (copy in `docs/template-copy.md`).
5. Set each ad's prefill text to match the campaigns table.

Put the token, phone number ID, and business account ID into `.env`.

### 6. Connect WhatsApp to Chatwoot

In Chatwoot, add a new inbox, choose WhatsApp, and use Manual Setup (you control
the Meta app, so Manual Setup is the right path). Enter the phone number ID and
token. Set the webhook verify token to the same string you put in
`WHATSAPP_VERIFY_TOKEN`.

Then, in the Meta app dashboard under WhatsApp, Configuration, Webhooks, make
sure the `messages` field is subscribed. If you skip this the inbox will show as
disconnected. This is the single most common setup mistake.

Send a test message to the business number. It should appear in Chatwoot, and a
reply you type in Chatwoot should arrive on the phone.

### 7. Wire n8n to the database and Chatwoot

Open n8n and set up:

- A Postgres credential named `Postgres App`: host `postgres`, port `5432`,
  database `app`, user and password from `.env`. The imported workflows expect
  this credential name.
- Import the three workflows from `n8n/workflows/`. Open each, confirm the
  Postgres nodes point at the `Postgres App` credential, and activate them.

In Chatwoot, add a webhook or automation that calls
`https://flow.yourdomain.com/webhook/chatwoot-inbound` on new messages, so n8n
receives every inbound message.

Get a Chatwoot access token from your Chatwoot profile settings and put it in
`CHATWOOT_API_TOKEN`, along with the account and inbox IDs.

### 8. Fill the knowledge base

Build the Google Sheet using `docs/knowledge-base-template.md`, publish it as
CSV, and put the URL in `KNOWLEDGE_BASE_CSV_URL`. Ask the bot a pricing
question and confirm the answer matches the sheet. Ask it something off-topic
and confirm it politely declines.

### 9. Add artwork

Drop sample files into the `media/` folder (or a Google Drive folder if you set
`MEDIA_SOURCE=drive`). Name them so the part before the double underscore is the
service key, for example `logo_design__sample1.jpg`. Run the uploader:

```bash
docker compose run --rm uploader
```

That runs the upload script in its own small python container, so nothing needs
python installed elsewhere. To do it on a schedule, add the same command to cron:

```bash
0 */6 * * * cd /opt/whatsapp-agent && docker compose run --rm uploader >> backups/uploader.log 2>&1
```

Workflow `03 - Media Sync` is an alternative that runs the script from inside
n8n, but only works if the n8n container has python. The uploader service above
is the reliable path.

### 10. Turn on the drip

Only after the templates are approved. Test with a shortened interval first
(see `docs/troubleshooting.md`), then activate `02 - Drip Cron`.

## Backups

`scripts/backup.sh` runs a full `pg_dumpall`, gzips it into `backups/`, and keeps
7 days. Add it to cron:

```bash
0 2 * * * cd /opt/whatsapp-agent && ./scripts/backup.sh >> backups/backup.log 2>&1
```

Offsite copies are your call. Add an upload step at the end of the script if you
want them.

## Costs

| Item | Cost |
|---|---|
| Chatwoot Community Edition | Free |
| n8n self-hosted | Free |
| Meta Cloud API access | Free, no middleman fee |
| Replies inside the 24-hour window | Free, unlimited |
| Marketing template (India) | Around 0.86 rupees each plus GST. Confirm against Meta's current rate card. |
| OpenAI gpt-4o-mini | Usage based, low at this volume |
| Server | Roughly 500 to 1,000 rupees a month |

At about 200 leads a month with three follow-ups each, expect roughly 1,500 to
2,500 rupees a month all in. Template cost scales with lead volume, the rest
stays flat. Verify all pricing against Meta's own current documentation before
quoting anyone.

## Where things live

- `docker-compose.yml`: the whole stack.
- `.env`: your secrets. Never commit this. `.env.example` is the template.
- `db/`: schema and seed data.
- `n8n/workflows/`: the automations, version controlled.
- `n8n/prompts/system-prompt.txt`: the AI's instructions.
- `scripts/`: media uploader, number registration notes, backup.
- `docs/`: knowledge base template, drip copy, troubleshooting.
- `HANDOVER.md`: credentials, access revoke list, and the runbook.
