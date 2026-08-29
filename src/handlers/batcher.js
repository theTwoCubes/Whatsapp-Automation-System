// Batches rapid messages from the same conversation into a single AI call.
// The last call in the batch replies; others return quietly.
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
