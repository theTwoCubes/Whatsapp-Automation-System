// Handles a verified webhook payload. Runs after the route has already returned
// 200, so it must not throw back to the request. Messages and status callbacks
// arrive on the same endpoint with different shapes and are handled separately.
export async function processWebhook(body, deps) {
  const { meta, seen, log } = deps;

  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      if (!value) continue;

      if (value.messages?.length) {
        for (const msg of value.messages) {
          if (!seen.markIfNew(msg.id)) {
            log.info({ wamid: msg.id }, 'duplicate message, skipping');
            continue;
          }
          await handleMessage(value, msg, { meta, log });
        }
      }

      if (value.statuses?.length) {
        for (const status of value.statuses) {
          // One message id emits sent, delivered and read in turn, so dedup on
          // id plus status rather than id alone.
          if (!seen.markIfNew(`${status.id}:${status.status}`)) {
            continue;
          }
          logStatus(status, log);
        }
      }
    }
  }
}

async function handleMessage(value, message, deps) {
  const { meta, log } = deps;
  const from = message.from;
  const contactName = value.contacts?.[0]?.profile?.name;

  log.info({ wamid: message.id, from, type: message.type, contactName }, 'inbound message received');

  if (message.type !== 'text' || !message.text?.body) {
    log.info({ wamid: message.id, type: message.type }, 'non text message, not echoing');
    return;
  }

  try {
    await meta.sendText(from, `Received: ${message.text.body}`);
  } catch (err) {
    log.error({ wamid: message.id, from, err }, 'failed to send echo reply');
  }
}

function logStatus(status, log) {
  const base = { wamid: status.id, status: status.status, recipient: status.recipient_id };
  if (status.status === 'failed') {
    log.warn({ ...base, errors: status.errors }, 'message status: failed');
  } else {
    log.info(base, `message status: ${status.status}`);
  }
}
