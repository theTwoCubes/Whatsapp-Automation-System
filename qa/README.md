# QA

Automated tests for the whole system. They run against a throwaway Postgres
database (`whatsapp_test`, created automatically) with Meta and OpenAI faked, so
nothing external is called and no real messages are sent.

## Run

    npm run qa

or

    bash qa/run.sh

Each run writes a timestamped report to `qa/results/`. The exit code is non zero
if anything fails.

## What is covered

Every file under `tests/` runs. The main ones:

- `webhook.test.js` inbound capture, campaign attribution, dedup, AI reply and
  fallback, handoff, status callbacks, service/pack selection
- `api.test.js` console login, auth, conversation list, take over and give back,
  agent reply
- `resume.test.js` auto resume, manual handback catch-up, and the 5 minute
  retry for conversations the AI left stuck
- `drip.test.js` scheduling, reset on reply, cancel on handoff, sending due
  follow ups
- `reply.test.js` / `ai.test.js` prompt building, decision parsing, provider
  failover
- `packs.test.js` / `faqs.test.js` / `ingestion.test.js` the knowledge base
- `vision.test.js` reading an inbound image, Gemini first with OpenAI fallback
- `handoff.test.js` the qualification gate and the handoff lifecycle
- `bulk-send.test.js`, `realtime.test.js`, `hardening.test.js`,
  `ratelimit.test.js`, `scale.test.js`, `monitoring.test.js` the operational
  surface: bulk sends, the live websocket, security headers, limits, load

Run `ls qa/tests/*.test.js` for the full list.

## Layout

    qa/
      run.sh              the runner
      results/            saved reports, one per run
      tests/              the test files
      tests/support/      shared helpers and fakes
