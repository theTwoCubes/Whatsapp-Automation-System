# Onboarding a client

A checklist for setting up the platform for a new client. Everything after step 3
is done from the console, not from Meta.

## 1. Accounts and keys

- WhatsApp: the client's `META_PHONE_NUMBER_ID`, `META_WABA_ID`, a permanent
  System User `META_ACCESS_TOKEN`, and the `META_APP_SECRET`.
- AI: an `OPENAI_API_KEY` and/or `GEMINI_API_KEY`, and `AI_PROVIDER` for the
  primary. The other is used as automatic failover. Set `GEMINI_API_KEY`
  even if OpenAI is primary - it's also what reads an inbound photo/PDF.
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
  bot answers from. State plainly that pricing is fixed if it is - the bot only
  refuses to negotiate when the knowledge base actually says so.
- Payment links (Knowledge → Payment Links): if a service has a paid step (a
  deposit, a paid consultation, anything with a real payment link), add it here
  with a description of when it applies. Leave this empty for services with no
  such step.
- Settings: set the business name, tone, the fallback and handoff messages, and
  the auto resume timeout.
- Templates: create the follow up and re-engagement templates, then submit them
  for Meta approval and Sync once approved. Only after that set the drip
  schedule on the Follow-ups page - a step naming a template that is not
  approved in this WABA just fails at send time. Leave it empty until then.
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
