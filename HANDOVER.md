# Handover

This system is built to be owned by you, not by the builder. Everything below
is here so that you, or any developer you hire later, can run it without the
original builder.

The builder provides 15 days of post-launch support. After that the system is
fully in your hands, and nothing here depends on the builder's personal access.

## The one rule that makes this safe

The system authenticates to WhatsApp as your Meta System User, not as the
builder's personal account. So when you revoke the builder's access at handover,
nothing breaks. If anyone set this up with a personal token, fix it before
handover (see `scripts/register_number.md`).

## Credentials checklist

Fill in where each secret lives once, then store this list somewhere safe and
private. Do not commit it.

| Secret | Where it lives | Where it is used |
|---|---|---|
| WhatsApp System User token | `.env` `WHATSAPP_TOKEN` | Sending templates and media |
| WhatsApp phone number ID | `.env` `WHATSAPP_PHONE_NUMBER_ID` | Meta API calls |
| WhatsApp business account ID | `.env` `WHATSAPP_BUSINESS_ACCOUNT_ID` | Meta management |
| Webhook verify token | `.env` `WHATSAPP_VERIFY_TOKEN` | Meta webhook verification |
| OpenAI API key | `.env` `OPENAI_API_KEY` | AI replies |
| Chatwoot access token | `.env` `CHATWOOT_API_TOKEN` | Posting replies and labels |
| Chatwoot secret key base | `.env` `CHATWOOT_SECRET_KEY_BASE` | Chatwoot sessions |
| Postgres password | `.env` `POSTGRES_PASSWORD` | Database access |
| Redis password | `.env` `REDIS_PASSWORD` | Chatwoot queue |
| n8n encryption key | `.env` `N8N_ENCRYPTION_KEY` | n8n credential storage |
| n8n basic auth password | `.env` `N8N_BASIC_AUTH_PASSWORD` | n8n login |
| Knowledge base sheet URL | `.env` `KNOWLEDGE_BASE_CSV_URL` | Reading services and prices |

## How to rotate a credential

- WhatsApp token: generate a new System User token in Business Settings, update
  `.env`, then `docker compose up -d` to restart n8n. The old token can then be
  revoked.
- OpenAI key: create a new key in the OpenAI dashboard, update `.env`, restart,
  revoke the old key.
- Chatwoot token: create a new access token in Chatwoot profile settings, update
  `.env`, restart.
- Passwords in `.env`: change the value, restart the stack. For the Postgres
  password you must also update it inside Postgres, so coordinate that change.

## Access revoke checklist for handover

Go through every place the builder was given access during the build and remove
it. Tick each one:

- [ ] Remove the builder from the Meta Business account (Business Settings, People).
- [ ] Remove the builder's access to the WhatsApp Business Account.
- [ ] Confirm the app uses the System User token, not the builder's token.
- [ ] Remove the builder from the Chatwoot account (Agents).
- [ ] Remove the builder's n8n login if one was created.
- [ ] Rotate the OpenAI key if the builder ever saw it.
- [ ] Remove the builder's SSH access to the server.
- [ ] Remove the builder from the Google Sheet share list.
- [ ] Change the server login password if it was shared.

After this list, the builder has no way into any part of the system, and the
system keeps running.

## Runbook

### The bot stopped replying

1. Is the conversation assigned to a human in Chatwoot? That silences the bot on
   purpose. Unassign to hand back.
2. Is workflow `01 - Inbound Message` active in n8n?
3. Check the n8n execution log for the failing node. Usual causes: wrong OpenAI
   key, wrong Chatwoot token, or the Postgres credential not selected.
4. See `docs/troubleshooting.md` for the full list.

### Templates were rejected

Rewrite toward genuinely useful copy, not a sales pitch. See
`docs/template-copy.md`. Resubmit in WhatsApp Manager.

### Drip errors with code 131049

Normal. It is Meta's frequency cap, not a fault. The system retries on its own.
No action needed.

### Server is full

1. Check disk with `df -h`.
2. Old backups in `backups/` are pruned to 7 days, but check anyway.
3. Docker can accumulate old images: `docker system prune` frees space. Read
   what it will remove before confirming.
4. Chatwoot and Postgres data grow over time. If tight, move to a bigger disk.

### Restore from backup

Backups are gzipped `pg_dumpall` files in `backups/`. To restore into a running
stack:

```bash
gunzip -c backups/all-databases-YYYYMMDD-HHMMSS.sql.gz | \
  docker compose exec -T postgres psql -U postgres
```

This restores all databases. Do it on a fresh instance, or after dropping the
existing databases, to avoid conflicts. Test a restore before you need it.

## Day-to-day tasks

- Edit services or prices: edit the Google Sheet. The bot picks up changes on
  the next message, no restart needed.
- Add artwork: drop a file in the media source named
  `service_key__anything.jpg`, then let `03 - Media Sync` run or run the uploader
  by hand.
- Submit a new template: draft it useful, submit in WhatsApp Manager, and once
  approved make sure the name matches `.env`.
- Take over a chat: in Chatwoot, assign the conversation to yourself. The bot
  goes quiet. Unassign to hand it back to the bot.
