const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Full jitter around an exponentially growing base, so a homeserver that just came
 * back doesn't get every queued retry in the same millisecond.
 */
function backoffFor(attempt, baseMs) {
  const ceiling = baseMs * 2 ** (attempt - 1);
  return Math.round(ceiling * (0.75 + Math.random() * 0.5));
}

/**
 * Deliver one message to one target, retrying transient failures.
 *
 * Collabcast acknowledges a Collaboard delivery before it forwards anything, which
 * keeps a slow destination from making Collaboard retry (and so from duplicating
 * messages). The cost of acking early is that a failed send is ours to own — which
 * is what this retry loop is for.
 *
 * A connector can mark an error `permanent` (a bad token, a room it cannot post to)
 * to skip the remaining attempts, or set `retryAfterMs` to override the backoff when
 * the destination said exactly how long to wait.
 */
export async function deliver({ target, message, attempts, backoffMs, log }) {
  const context = { target: target.name, event: message.event.type, eventId: message.event.id };

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await target.instance.send(message);
      log.info("delivered", { ...context, ...(attempt > 1 ? { attempt } : {}) });
      return true;
    } catch (error) {
      const lastAttempt = attempt === attempts;
      const giveUp = lastAttempt || error.permanent === true;

      if (giveUp) {
        log.error("delivery failed, giving up", {
          ...context,
          attempt,
          attempts,
          reason: error.permanent === true ? "permanent" : "attempts exhausted",
          error: error.message,
        });
        return false;
      }

      const waitMs = Number.isFinite(error.retryAfterMs) ? error.retryAfterMs : backoffFor(attempt, backoffMs);
      log.warn("delivery failed, retrying", { ...context, attempt, retryInMs: waitMs, error: error.message });
      await sleep(waitMs);
    }
  }

  return false;
}
