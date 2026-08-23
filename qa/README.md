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

- `webhook.test.js` inbound capture, campaign attribution, dedup, AI reply and
  fallback, keyword handoff, status callbacks
- `drip.test.js` scheduling, reset on reply, cancel on handoff, sending due
  follow ups
- `api.test.js` console login, auth, conversation list, take over and give back,
  agent reply
- `realtime.test.js` the live update websocket end to end against the real
  server

## Layout

    qa/
      run.sh              the runner
      results/            saved reports, one per run
      tests/              the test files
      tests/support/      shared helpers and fakes
