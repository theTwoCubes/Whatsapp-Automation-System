# Registering the WhatsApp number (manual Meta steps)

These steps happen in Meta's web UI and are not automated. Do them in order.
The client should own every account here; the builder only assists.

## Before you start
- Confirm the WABA currency (INR vs USD). Currency is fixed when the WABA is
  created and cannot be changed later. If INR billing is wanted and the WABA is
  USD, create a fresh WABA before registering the number.
- Confirm the phone number is clean: not on the WhatsApp consumer app, not on
  the WhatsApp Business app, and not tied to a previous BSP. A prior BSP's WABA
  must be removed first.

## 1. Register the phone number
Meta app dashboard, WhatsApp, API Setup. Add the phone number and complete the
verification code step. Note the Phone Number ID and WhatsApp Business Account
ID shown on this screen. These go in `.env` as `WHATSAPP_PHONE_NUMBER_ID` and
`WHATSAPP_BUSINESS_ACCOUNT_ID`.

## 2. Create a System User and a permanent token
Business Settings, Users, System Users. Create a System User owned by the
client's business. Assign the WABA to it. Generate a token with these scopes:
- `whatsapp_business_messaging`
- `whatsapp_business_management`

Use this token as `WHATSAPP_TOKEN`. Do not use a personal user token. A personal
token dies the moment the builder's access is revoked at handover; the System
User token survives.

## 3. Add a payment method
The client does this himself, on the client's own card. Meta bills on a rising
threshold; there are no prepaid credits. The builder never handles the card.

## 4. Configure the webhook
This is done inside Chatwoot's inbox setup, not by hand in the Meta app, when
using Manual Setup. See README Phase 1. The one field that must be subscribed is
`messages`. Without it the inbox shows "disconnected" and inbound stops.

## 5. Set the callback verify token
`WHATSAPP_VERIFY_TOKEN` in `.env` is a string you choose. The same string must
be entered in the Meta app webhook configuration so Meta's verification call
succeeds.

## 6. Set the ad prefill text
In Meta Ads Manager, each Click-to-WhatsApp ad has a prefilled first message.
Set it to exactly match the matching row in `db/002_seed_campaigns.sql`
(`campaigns.match_text`). If they drift, campaign detection stops working.
