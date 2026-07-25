import { test } from "node:test";
import assert from "node:assert/strict";

import { normalize, summarize } from "../src/event.mjs";

const envelope = (event, data, overrides = {}) => ({
  event,
  eventId: "01J9ZQK8H6F4N3M2P7R5T8V0XW",
  occurredAt: "2026-06-18T16:42:25.770Z",
  version: "1",
  boardId: "f6fa6794-4bed-44d0-9656-de8080791302",
  boardSlug: "research",
  actor: { userId: "52df8c11", name: "Alex Rivera", role: "Administrator" },
  data,
  ...overrides,
});

const card = { id: "a1b2", number: 321, name: "Investigate flaky test" };

test("normalize lifts the envelope and keeps data intact", () => {
  const event = normalize(envelope("card.created", { card, laneName: "Inbox" }));

  assert.equal(event.id, "01J9ZQK8H6F4N3M2P7R5T8V0XW");
  assert.equal(event.type, "card.created");
  assert.equal(event.board.slug, "research");
  assert.equal(event.actor.name, "Alex Rivera");
  assert.equal(event.actor.isHuman, true);
  assert.equal(event.data.laneName, "Inbox");
});

test("normalize tolerates unknown fields and a missing data block", () => {
  const event = normalize({ event: "card.created", somethingNew: { nested: true } });
  assert.equal(event.type, "card.created");
  assert.deepEqual(event.data, {});
  assert.equal(event.actor.name, null);
  assert.equal(event.actor.isHuman, false);
});

test("agent roles are not human — allowlist, not denylist", () => {
  for (const role of ["AgentUser", "AgentAdministrator", "SomeFutureAgentRole"]) {
    const event = normalize(envelope("card.created", { card }, { actor: { name: "Bot", role } }));
    assert.equal(event.actor.isHuman, false, `${role} must not be treated as human`);
  }
  for (const role of ["Administrator", "HumanUser"]) {
    const event = normalize(envelope("card.created", { card }, { actor: { name: "Person", role } }));
    assert.equal(event.actor.isHuman, true);
  }
});

test("a ping carries no board scope", () => {
  const event = normalize({ event: "webhook.ping", boardId: "", boardSlug: "", data: { message: "hello" } });
  assert.equal(event.board.slug, null);
  assert.equal(event.board.id, null);
});

test("summarize renders card.created", () => {
  const summary = summarize(normalize(envelope("card.created", { card, laneName: "Inbox" })));
  assert.equal(summary.icon, "🆕");
  assert.equal(summary.text, "[research] created #321 Investigate flaky test in Inbox · Alex Rivera");
});

test("summarize renders card.moved with both lane names", () => {
  const summary = summarize(
    normalize(
      envelope("card.moved", {
        card,
        laneName: "Ready",
        from: { laneId: "1", laneName: "Doing", position: 3 },
        to: { laneId: "2", laneName: "Ready", position: 0 },
      }),
    ),
  );
  assert.equal(summary.text, "[research] moved #321 Investigate flaky test from Doing to Ready · Alex Rivera");
  assert.match(summary.html, /<b>Doing<\/b>/);
  assert.match(summary.html, /<b>Ready<\/b>/);
});

test("agent actors are marked in the summary", () => {
  const summary = summarize(
    normalize(envelope("card.created", { card, laneName: "Inbox" }, { actor: { name: "Scout", role: "AgentUser" } })),
  );
  assert.match(summary.text, /· Scout \(agent\)$/);
});

test("summary html escapes card content", () => {
  const hostile = { number: 7, name: '<img src=x onerror="alert(1)">' };
  const summary = summarize(normalize(envelope("card.created", { card: hostile, laneName: "Inbox" })));
  assert.ok(!summary.html.includes("<img"), "raw markup must not survive into html");
  assert.match(summary.html, /&lt;img/);
});

test("deep links are added only when a base URL is configured", () => {
  const event = normalize(envelope("card.created", { card, laneName: "Inbox" }));

  const without = summarize(event);
  assert.ok(!without.html.includes("<a href"));

  const withLinks = summarize(event, { baseUrl: "http://board.example.org:8080" });
  assert.match(withLinks.html, /<a href="http:\/\/board\.example\.org:8080\/boards\/research\/cards\/321">/);
  // The plain-text form stays identical either way.
  assert.equal(withLinks.text, without.text);
});

test("summarize covers every family without throwing", () => {
  const cases = [
    ["card.updated", { card, laneName: "Inbox" }],
    ["card.archived", { card, laneName: "Archive" }],
    ["card.restored", { card, laneName: "Inbox" }],
    ["card.labeled", { card, laneName: "Inbox", label: { id: "1", name: "Bug", color: "#f00" } }],
    ["card.unlabeled", { card, laneName: "Inbox", label: { id: "1", name: "Bug", color: null } }],
    ["comment.created", { comment: { contentMarkdown: "Looks good, shipping." }, card: { id: "a", number: 321 } }],
    ["comment.updated", { comment: {}, card: { id: "a", number: 321 } }],
    ["comment.deleted", { comment: {}, card: { id: "a", number: 321 } }],
    ["label.created", { label: { name: "Bug" } }],
    ["label.updated", { label: { name: "Bug" } }],
    ["label.deleted", { label: { name: "Bug" } }],
    ["attachment.created", { attachment: { fileName: "shot.png", sizeBytes: 51234 }, card: { number: 321 } }],
    ["attachment.deleted", { attachment: { fileName: "shot.png" }, card: { number: 321 } }],
    ["lane.created", { lane: { name: "Ready" } }],
    ["lane.renamed", { lane: { name: "Triage" } }],
    ["lane.deleted", { lane: { name: "Ready" } }],
    ["lane.reordered", { lanes: [{ name: "Backlog" }, { name: "Doing" }, { name: "Done" }] }],
    ["board.created", { board: { slug: "research", name: "Research" } }],
    ["board.renamed", { board: { slug: "research", name: "Research" } }],
    ["board.deleted", { board: { slug: "research", name: "Research" } }],
    ["webhook.ping", { subscriptionId: "abc", message: "hello" }],
  ];

  for (const [type, data] of cases) {
    const summary = summarize(normalize(envelope(type, data)));
    assert.ok(summary.text.length > 0, `${type} produced no text`);
    assert.ok(summary.icon.length > 0, `${type} produced no icon`);
  }
});

test("comment excerpts are flattened and truncated", () => {
  const long = "a".repeat(400);
  const summary = summarize(
    normalize(envelope("comment.created", { comment: { contentMarkdown: `line\n\n${long}` }, card: { number: 9 } })),
  );
  assert.ok(!summary.text.includes("\n"));
  assert.ok(summary.text.includes("…"));
});

test("an unknown future event type still renders", () => {
  const summary = summarize(normalize(envelope("card.frobnicated", { card })));
  assert.equal(summary.icon, "•");
  assert.match(summary.text, /card\.frobnicated/);
});

test("attachment size is rendered in human units", () => {
  const summary = summarize(
    normalize(envelope("attachment.created", { attachment: { fileName: "a.png", sizeBytes: 51234 }, card: { number: 1 } })),
  );
  assert.match(summary.text, /\(50\.0 KB\)/);
});

test("an event type that names an Object.prototype member gets the fallback icon", () => {
  // `event` is untrusted, and the icon table is looked up by it. A prototype hit
  // would not be nullish, so it would sail past the `??` and be rendered.
  for (const type of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
    const summary = summarize(normalize(envelope(type, {})));
    assert.equal(summary.icon, "•", `${type} should not resolve through the prototype`);
    assert.equal(typeof summary.text, "string");
  }
});
