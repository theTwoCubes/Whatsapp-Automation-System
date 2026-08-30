# Onboarding a client

A checklist for setting up the platform for a new client. Everything after step 3
is done from the console, not from Meta.

## 1. Accounts and keys

- WhatsApp: the client's `META_PHONE_NUMBER_ID`, `META_WABA_ID`, a permanent
  System User `META_ACCESS_TOKEN`, and the `META_APP_SECRET`.
- AI: an `OPENAI_API_KEY` and/or `GEMINI_API_KEY`, and `AI_PROVIDER` for the
  primary. The other is used as automatic failover.
- A `JWT_SECRET`, and the first console login (`ADMIN_EMAIL`, `ADMIN_PASSWORD`).
- Firebase (for Push Notifications): A Firebase project with an Android app configured for the package `com.wamanager.console`. You need the `google-services.json` file.

## 2. Deploy

Follow DEPLOY.md. On boot the app runs migrations and seeds the admin login.

## 3. Point the webhook

In the Meta app dashboard set the callback URL to `https://YOUR-DOMAIN/webhook`,
the verify token to `WEBHOOK_VERIFY_TOKEN`, and tick the `messages` field.

## 4. Set it up from the console

Sign in and open Admin:

- Business profile: fill in the about, description, email and website. This is the
  client's public WhatsApp profile.
- Knowledge base: add the client's services, pricing and FAQs. This is what the
  bot answers from.
- Settings: set the business name, tone, the fallback and handoff messages, the
  drip schedule, and the auto resume timeout.
- Templates: create the day 3, 5 and 8 follow up templates and any re-engagement
  templates, then submit them for Meta approval. Sync once approved.
- Branding: set the console name, watermark, support email and accent colour for
  a white labelled console.
- Agents: add logins for the client's team.

## 5. Test

Message the client's number from a phone. Confirm the bot replies from the
knowledge base, that a chat can be taken over and handed back, and that a media
message and an approved template both send.

## Notes

- The audit log under Admin records who did what, and can be filtered by date.
- Auto resume, drip timing and the AI tone are all editable in Settings without a
  redeploy.
