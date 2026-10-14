// Batches rapid messages from the same conversation into a single AI call.
// The last call in the batch replies; others return quietly.
//
// Two things have to hold for a lead who fires off three messages in a row to
// get one answer instead of three:
//
//   1. The debounce waits for them to stop typing. This only covers the gap
//      between messages, not the time spent answering.
//   2. Nothing is answered while an answer is already being written. Without
//      this, a message landing during the AI call (which runs anywhere from
//      1.5 to 8 seconds) opened a second batch and a second reply chased the
//      first one out, a few seconds behind it. That was the "it replied to me
//      three times" behaviour, and raising the debounce alone cannot fix it -
//      the window that matters is however long the model takes.
export function createBatcher({ debounceMs, maxWaitMs }) {
  const batches = new Map();
  // conversationId -> promise that settles when the in-progress reply is done.
  const inFlight = new Map();

  function enqueueMessage(conversationId, item) {
    return new Promise((resolve) => {
      let batch = batches.get(conversationId);
      if (!batch) {
        batch = { items: [], resolvers: [], timer: null, maxTimer: null, waiting: false };
        batch.maxTimer = setTimeout(() => flush(conversationId), maxWaitMs);
        batches.set(conversationId, batch);
      }
      batch.items.push(item);
      batch.resolvers.push(resolve);
      if (batch.timer) clearTimeout(batch.timer);
      batch.timer = setTimeout(() => flush(conversationId), debounceMs);
    });
  }

  // Claimed by the one caller that is about to reply, released when it is
  // finished. While held, a batch for that conversation stays open rather
  // than being answered in parallel.
  function beginReply(conversationId) {
    let release;
    const done = new Promise((resolve) => { release = resolve; });
    inFlight.set(conversationId, done);
    return () => {
      // Only clear if this is still the registered reply - a release arriving
      // late must not unlock a newer one that has since claimed the slot.
      if (inFlight.get(conversationId) === done) inFlight.delete(conversationId);
      release();
    };
  }

  function flush(conversationId) {
    const batch = batches.get(conversationId);
    if (!batch) return;

    const pending = inFlight.get(conversationId);
    if (pending) {
      // Hold everything until the reply being written has gone out, then take
      // one more look - by which point these messages, and anything else that
      // arrives in the meantime, are a single batch and get a single answer.
      if (!batch.waiting) {
        batch.waiting = true;
        clearTimeout(batch.timer);
        clearTimeout(batch.maxTimer);
        batch.timer = null;
        batch.maxTimer = null;
        pending.then(() => {
          // The batch may already have been flushed by something else.
          const still = batches.get(conversationId);
          if (!still || still !== batch) return;
          batch.waiting = false;
          flush(conversationId);
        });
      }
      return;
    }

    batches.delete(conversationId);
    clearTimeout(batch.timer);
    clearTimeout(batch.maxTimer);
    for (const resolve of batch.resolvers) resolve(batch.items);
  }

  return { enqueueMessage, beginReply };
}
