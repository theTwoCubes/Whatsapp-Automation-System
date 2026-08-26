// Coalesces rapid fire messages from the same conversation into one AI call.
// Each caller enqueues its own message and awaits the same promise; whichever
// call ends up holding the last item in the flushed batch is the one
// responsible for actually replying, the rest just return quietly since their
// message is already recorded. In process only, single instance is fine for
// now, same reasoning as the drip scheduler.
export function createBatcher({ debounceMs, maxWaitMs }) {
  const batches = new Map();

  function enqueueMessage(conversationId, item) {
    return new Promise((resolve) => {
      let batch = batches.get(conversationId);
      if (!batch) {
        batch = { items: [], resolvers: [], timer: null, maxTimer: null };
        batch.maxTimer = setTimeout(() => flush(conversationId), maxWaitMs);
        batches.set(conversationId, batch);
      }
      batch.items.push(item);
      batch.resolvers.push(resolve);
      if (batch.timer) clearTimeout(batch.timer);
      batch.timer = setTimeout(() => flush(conversationId), debounceMs);
    });
  }

  function flush(conversationId) {
    const batch = batches.get(conversationId);
    if (!batch) return;
    batches.delete(conversationId);
    clearTimeout(batch.timer);
    clearTimeout(batch.maxTimer);
    for (const resolve of batch.resolvers) resolve(batch.items);
  }

  return { enqueueMessage };
}
