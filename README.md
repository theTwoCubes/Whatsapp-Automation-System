# WhatsApp Automation

WhatsApp Cloud API service for a lead nurturing agent. Receives inbound
messages through a webhook and replies within the 24 hour customer service
window. This is the messaging layer only. The AI replies, database, drip
campaigns and agent console are built on top of this in later phases.

The system is inbound first. A lead messages the business, which opens the 24
hour window, and every reply after that goes out inside that window.

## Stack

Node.js with Fastify. Fastify is used for its built in pino logging with request
ids and for the raw body access needed to verify webhook signatures.

## Requirements

- Node.js 20 or newer
- A tunnel such as ngrok or cloudflared to expose the local server to Meta
- A Meta app with the WhatsApp product, a phone number id, an access token and
  the app secret

## Setup

Install dependencies:

    npm install

Copy the env template and fill it in:

    cp .env.example .env

| Variable | Where it comes from |
| --- | --- |
| META_PHONE_NUMBER_ID | Meta app, WhatsApp, API Setup |
| META_WABA_ID | WhatsApp Business Account id |
| META_ACCESS_TOKEN | Graph API access token |
| META_APP_SECRET | Meta app, Settings, Basic. Not the access token |
| WEBHOOK_VERIFY_TOKEN | A string you choose, reused in the dashboard config |
| PORT | Optional, defaults to 3000 |
| GRAPH_API_VERSION | Optional, defaults to v21.0 |

Required variables are checked at boot. A missing one stops the server with a
message naming what is absent.

## Run

Start the server:

    npm run dev

Expose it in a second terminal:

    ngrok http 3000

Copy the https url that ngrok prints. On the free tier the url changes on every
restart, so the callback url has to be re-entered each time. cloudflared gives a
stable url if that becomes a problem.

## Webhook configuration in Meta

1. Meta app dashboard, WhatsApp, Configuration.
2. Set the callback url to https://YOUR-URL/webhook
3. Set the verify token to the value of WEBHOOK_VERIFY_TOKEN in .env
4. Save. The GET handshake should pass.
5. Click Manage next to the webhook fields and tick the messages field. Without
   this the webhook verifies but never receives anything.

## Endpoints

- GET /health returns a small status object.
- GET /webhook handles the Meta verification handshake.
- POST /webhook receives inbound messages and status callbacks. It verifies the
  X-Hub-Signature-256 signature, replies 200 before processing, deduplicates on
  the message id and echoes text messages back.

## Notes

Every Cloud API call goes through src/meta/client.js. Nothing else talks to Meta
directly, so switching accounts is a matter of changing the env file.
