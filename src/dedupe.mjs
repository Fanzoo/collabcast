/**
 * Collattice delivery is at-least-once: a retry after a flaky response can deliver
 * the same event twice, and the `eventId` (a ULID) is stable across retries. This
 * is a bounded FIFO memory of recently-seen ids — enough to absorb a retry storm
 * without growing without limit.
 *
 * It is in-process and deliberately not persisted. Connectors get a second,
 * independent line of defense where their destination offers one (the Matrix
 * connector derives its transaction id from the event id), so a restart that
 * clears this set is not a correctness problem.
 */
export function createDedupe(capacity = 2048) {
  const seen = new Set();
  const order = [];

  return {
    /** Record an id and report whether it had already been seen. */
    check(id) {
      // No id to key on — let it through rather than dropping a real event.
      if (!id) return false;
      if (seen.has(id)) return true;
      seen.add(id);
      order.push(id);
      if (order.length > capacity) seen.delete(order.shift());
      return false;
    },
    get size() {
      return seen.size;
    },
  };
}
