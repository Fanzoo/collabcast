import { test } from "node:test";
import assert from "node:assert/strict";

import { normalize } from "../src/event.mjs";
import { matches, route } from "../src/router.mjs";

const event = (type, extra = {}) =>
  normalize({
    event: type,
    eventId: `id-${type}`,
    boardSlug: "research",
    actor: { name: "Alex", role: "Administrator" },
    data: {},
    ...extra,
  });

test("an empty events list matches everything", () => {
  assert.equal(matches(event("card.created"), {}), true);
  assert.equal(matches(event("lane.deleted"), { events: [] }), true);
});

test("the wildcard matches everything", () => {
  assert.equal(matches(event("board.renamed"), { events: ["*"] }), true);
});

test("an explicit list matches only what it names", () => {
  const when = { events: ["card.created", "card.moved"] };
  assert.equal(matches(event("card.created"), when), true);
  assert.equal(matches(event("card.moved"), when), true);
  assert.equal(matches(event("card.updated"), when), false);
});

test("a board allowlist filters by slug", () => {
  const when = { boards: ["research"] };
  assert.equal(matches(event("card.created"), when), true);
  assert.equal(matches(event("card.created", { boardSlug: "scratch" }), when), false);
});

test("a board allowlist does not swallow a ping", () => {
  // A ping is not board-scoped, so it must stay visible to a board-filtered route.
  const ping = normalize({ event: "webhook.ping", boardSlug: "", data: {} });
  assert.equal(matches(ping, { events: ["webhook.ping"], boards: ["research"] }), true);
});

test("humanActorsOnly drops agent-caused events", () => {
  const when = { humanActorsOnly: true };
  assert.equal(matches(event("card.created"), when), true);
  assert.equal(
    matches(event("card.created", { actor: { name: "Bot", role: "AgentAdministrator" } }), when),
    false,
  );
});

test("enterLanes matches the lane a card landed in", () => {
  const moved = event("card.moved", {
    data: { card: { number: 1 }, from: { laneName: "Doing" }, to: { laneName: "Ready" } },
  });
  assert.equal(matches(moved, { enterLanes: ["Ready"] }), true);
  assert.equal(matches(moved, { enterLanes: ["Done"] }), false);
  // Falls back to the resolved lane for events without a transition.
  const created = event("card.created", { data: { card: { number: 1 }, laneName: "Inbox" } });
  assert.equal(matches(created, { enterLanes: ["Inbox"] }), true);
  assert.equal(matches(created, { enterLanes: ["Ready"] }), false);
});

test("enterLanes drops events that have no lane at all", () => {
  assert.equal(matches(event("board.renamed"), { enterLanes: ["Ready"] }), false);
});

test("conditions are ANDed", () => {
  const when = { events: ["card.moved"], boards: ["research"], enterLanes: ["Ready"], humanActorsOnly: true };
  const base = {
    data: { card: { number: 1 }, from: { laneName: "Doing" }, to: { laneName: "Ready" } },
  };
  assert.equal(matches(event("card.moved", base), when), true);
  assert.equal(matches(event("card.moved", { ...base, boardSlug: "other" }), when), false);
  assert.equal(
    matches(event("card.moved", { ...base, actor: { name: "Bot", role: "AgentUser" } }), when),
    false,
  );
});

test("two routes naming the same target deliver once", () => {
  const routes = [
    { name: "a", when: { events: ["card.created"] }, to: ["chat"] },
    { name: "b", when: { events: ["*"] }, to: ["chat", "log"] },
  ];
  const result = route(event("card.created"), routes);
  assert.deepEqual(result.targets.sort(), ["chat", "log"]);
  assert.deepEqual(result.routes.map((r) => r.name), ["a", "b"]);
});

test("no matching route yields no targets", () => {
  const routes = [{ name: "a", when: { events: ["card.moved"] }, to: ["chat"] }];
  assert.deepEqual(route(event("comment.created"), routes).targets, []);
});

test("a board allowlist does not leak events that arrive without a slug", () => {
  // The ping exemption is for the ping, not for "no slug" — an event that turns up
  // slugless for any other reason must not slip past a board-scoped route.
  const when = { boards: ["research"] };
  assert.equal(matches(event("card.created", { boardSlug: "" }), when), false);
  assert.equal(matches(event("card.created", { boardSlug: undefined }), when), false);
  assert.equal(matches(event("card.frobnicated", { boardSlug: null }), when), false);
  assert.equal(matches(event("webhook.ping", { boardSlug: "" }), when), true);
});
