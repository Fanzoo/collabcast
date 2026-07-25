import { PING } from "./events.mjs";

/**
 * Route matching. Every condition in a route's `when` block must hold for the
 * route to match — conditions are ANDed, and an absent or empty condition means
 * "no restriction on this axis".
 */

function matchesEventType(type, selection) {
  if (!selection || selection.length === 0 || selection.includes("*")) return true;
  return selection.includes(type);
}

/**
 * The lane a card came to rest in for this event: the move target on `card.moved`,
 * otherwise the resolved lane the event carries. Null for events with no lane.
 */
function landedLane(event) {
  return event.data?.to?.laneName ?? event.data?.laneName ?? null;
}

export function matches(event, when = {}) {
  if (!matchesEventType(event.type, when.events)) return false;

  // A ping is not board-scoped, so a board allowlist must not swallow it — that
  // would make the one tool for proving reachability the hardest thing to see. The
  // exemption is for the ping specifically, not for "no slug": keying it off a
  // missing slug would let any other slugless event through an allowlist that was
  // deliberately scoped away from it.
  if (when.boards?.length && event.type !== PING && !when.boards.includes(event.board?.slug)) return false;

  if (when.humanActorsOnly && !event.actor?.isHuman) return false;

  if (when.enterLanes?.length) {
    const lane = landedLane(event);
    if (!lane || !when.enterLanes.includes(lane)) return false;
  }

  return true;
}

/**
 * Resolve an event to the set of target names that should receive it. Two routes
 * naming the same target collapse to one delivery — a target hears about an event
 * once, however many routes selected it.
 */
export function route(event, routes) {
  const targets = new Set();
  const matched = [];
  for (const entry of routes) {
    if (!matches(event, entry.when)) continue;
    matched.push(entry);
    for (const target of entry.to) targets.add(target);
  }
  return { targets: [...targets], routes: matched };
}
