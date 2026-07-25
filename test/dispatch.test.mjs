import { test } from "node:test";
import assert from "node:assert/strict";

import { createDedupe } from "../src/dedupe.mjs";
import { deliver } from "../src/dispatch.mjs";

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const message = { event: { type: "card.created", id: "01J" }, summary: { icon: "🆕", text: "t", html: "t" } };

const target = (send) => ({ name: "chat", instance: { send } });

test("dedupe reports a repeat of the same id", () => {
  const dedupe = createDedupe(8);
  assert.equal(dedupe.check("a"), false);
  assert.equal(dedupe.check("a"), true);
  assert.equal(dedupe.check("b"), false);
});

test("dedupe lets an event with no id through rather than dropping it", () => {
  const dedupe = createDedupe(8);
  assert.equal(dedupe.check(null), false);
  assert.equal(dedupe.check(null), false);
  assert.equal(dedupe.check(undefined), false);
});

test("dedupe evicts oldest ids past capacity and stays bounded", () => {
  const dedupe = createDedupe(3);
  for (const id of ["a", "b", "c", "d"]) dedupe.check(id);
  assert.equal(dedupe.size, 3);
  assert.equal(dedupe.check("a"), false, "the oldest id should have been evicted");
  assert.equal(dedupe.check("d"), true, "the newest id should still be remembered");
});

test("a successful send is delivered once", async () => {
  let calls = 0;
  const ok = await deliver({
    target: target(async () => {
      calls++;
    }),
    message,
    attempts: 3,
    backoffMs: 0,
    log: silent,
  });
  assert.equal(ok, true);
  assert.equal(calls, 1);
});

test("a transient failure is retried and can succeed", async () => {
  let calls = 0;
  const ok = await deliver({
    target: target(async () => {
      calls++;
      if (calls < 3) throw new Error("connection refused");
    }),
    message,
    attempts: 4,
    backoffMs: 0,
    log: silent,
  });
  assert.equal(ok, true);
  assert.equal(calls, 3);
});

test("attempts are bounded", async () => {
  let calls = 0;
  const ok = await deliver({
    target: target(async () => {
      calls++;
      throw new Error("still down");
    }),
    message,
    attempts: 3,
    backoffMs: 0,
    log: silent,
  });
  assert.equal(ok, false);
  assert.equal(calls, 3);
});

test("a permanent error stops retrying immediately", async () => {
  let calls = 0;
  const ok = await deliver({
    target: target(async () => {
      calls++;
      /** @type {import("../types.js").DeliveryError} */
      const error = new Error("forbidden");
      error.permanent = true;
      throw error;
    }),
    message,
    attempts: 5,
    backoffMs: 0,
    log: silent,
  });
  assert.equal(ok, false);
  assert.equal(calls, 1, "a permanent failure must not be retried");
});

test("retryAfterMs from the destination is honoured", async () => {
  let calls = 0;
  const started = Date.now();
  const ok = await deliver({
    target: target(async () => {
      calls++;
      if (calls === 1) {
        /** @type {import("../types.js").DeliveryError} */
        const error = new Error("rate limited");
        error.retryAfterMs = 120;
        throw error;
      }
    }),
    message,
    // A huge backoff base proves the override is what was used, not the default.
    attempts: 3,
    backoffMs: 60_000,
    log: silent,
  });
  const elapsed = Date.now() - started;
  assert.equal(ok, true);
  assert.ok(elapsed >= 100, `expected to wait about 120ms, waited ${elapsed}ms`);
  assert.ok(elapsed < 5_000, `expected the override to win over the 60s base, waited ${elapsed}ms`);
});
