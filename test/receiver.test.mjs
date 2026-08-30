import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import { createReceiver, verifySignature, readDeliveryHeaders } from "../src/receiver.mjs";

const SECRET = "a-test-secret-that-is-long-enough";
const sign = (body, secret = SECRET) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

const silent = { info() {}, warn() {}, error() {}, debug() {}, child: () => silent };

const baseConfig = {
  listen: { host: "127.0.0.1", port: 0, path: "/collabcast", maxBodyBytes: 65_536 },
  signing: { secret: SECRET },
};

async function withServer(config, onEvent, run) {
  const server = createReceiver({ config, onEvent, log: silent });
  await new Promise((done) => server.listen(0, "127.0.0.1", () => done(null)));
  const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((done) => server.close(done));
  }
}

test("verifySignature accepts a genuine digest", () => {
  const body = Buffer.from('{"event":"card.created"}');
  assert.equal(verifySignature(body, sign(body), SECRET), true);
});

test("verifySignature rejects a wrong key, a tampered body, and a missing header", () => {
  const body = Buffer.from('{"event":"card.created"}');
  assert.equal(verifySignature(body, sign(body, "different-secret-value"), SECRET), false);
  assert.equal(verifySignature(Buffer.from('{"event":"card.moved"}'), sign(body), SECRET), false);
  assert.equal(verifySignature(body, undefined, SECRET), false);
  assert.equal(verifySignature(body, "", SECRET), false);
  assert.equal(verifySignature(body, "sha256=short", SECRET), false);
});

test("verifySignature is computed over the received bytes, not a reparse", () => {
  // Same object, different key order and whitespace — a genuine signature is over
  // the exact bytes that arrived, so a re-serialized copy must not verify.
  const received = Buffer.from('{"event":"card.created","eventId":"01J"}');
  const reserialized = Buffer.from(JSON.stringify({ eventId: "01J", event: "card.created" }));
  const header = sign(received);
  assert.equal(verifySignature(received, header, SECRET), true);
  assert.equal(verifySignature(reserialized, header, SECRET), false);
});

test("a delivery signed with the current X-Collattice-* headers is accepted", async () => {
  // The v3 rename. Reading only the legacy names answered every one of these 401,
  // which is the regression this guards.
  const seen = [];
  await withServer(baseConfig, (payload) => seen.push(payload), async (origin) => {
    const body = JSON.stringify({ event: "card.created", eventId: "01J" });
    const response = await fetch(`${origin}/collabcast`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Collattice-Signature": sign(Buffer.from(body)),
        "X-Collattice-Event": "card.created",
        "X-Collattice-Delivery-Id": "01J",
      },
      body,
    });
    assert.equal(response.status, 204);
  });
  assert.deepEqual(seen, [{ event: "card.created", eventId: "01J" }]);
});

test("readDeliveryHeaders prefers the current name and falls back to the legacy one", () => {
  assert.deepEqual(
    readDeliveryHeaders({ "x-collattice-signature": "new", "x-collattice-event": "card.moved", "x-collattice-delivery-id": "01A" }),
    { signature: "new", event: "card.moved", deliveryId: "01A" },
  );
  assert.deepEqual(
    readDeliveryHeaders({ "x-collaboard-signature": "old", "x-collaboard-event": "card.moved", "x-collaboard-delivery-id": "01B" }),
    { signature: "old", event: "card.moved", deliveryId: "01B" },
  );
  // Both present: the current name wins, so a sender emitting each spelling once
  // cannot make the digest and the logged id disagree about which delivery this is.
  assert.equal(
    readDeliveryHeaders({ "x-collattice-signature": "new", "x-collaboard-signature": "old" }).signature,
    "new",
  );
  assert.deepEqual(readDeliveryHeaders({}), { signature: undefined, event: undefined, deliveryId: undefined });
});

test("a correctly signed delivery is acknowledged and forwarded", async () => {
  const seen = [];
  await withServer(baseConfig, (payload) => seen.push(payload), async (origin) => {
    const body = JSON.stringify({ event: "card.created", eventId: "01J" });
    const response = await fetch(`${origin}/collabcast`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Collaboard-Signature": sign(Buffer.from(body)) },
      body,
    });
    assert.equal(response.status, 204);
  });
  assert.deepEqual(seen, [{ event: "card.created", eventId: "01J" }]);
});

test("an unsigned delivery is rejected when a secret is configured", async () => {
  const seen = [];
  await withServer(baseConfig, (payload) => seen.push(payload), async (origin) => {
    const response = await fetch(`${origin}/collabcast`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "card.created" }),
    });
    assert.equal(response.status, 401);
  });
  assert.equal(seen.length, 0, "a rejected delivery must never reach the handler");
});

test("deliveries are accepted unsigned when no secret is configured", async () => {
  const seen = [];
  const config = { ...baseConfig, signing: { secret: null } };
  await withServer(config, (payload) => seen.push(payload), async (origin) => {
    const response = await fetch(`${origin}/collabcast`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "card.moved" }),
    });
    assert.equal(response.status, 204);
  });
  assert.equal(seen.length, 1);
});

test("a malformed body is rejected with 400", async () => {
  const seen = [];
  await withServer(baseConfig, (payload) => seen.push(payload), async (origin) => {
    const body = "not json at all";
    const response = await fetch(`${origin}/collabcast`, {
      method: "POST",
      headers: { "X-Collaboard-Signature": sign(Buffer.from(body)) },
      body,
    });
    assert.equal(response.status, 400);
  });
  assert.equal(seen.length, 0);
});

test("an oversized body is rejected with 413", async () => {
  const config = { ...baseConfig, listen: { ...baseConfig.listen, maxBodyBytes: 1024 } };
  await withServer(config, () => {}, async (origin) => {
    // Far past the socket buffers, so the client is still writing when the cap trips —
    // the case where a naive close would strand the response.
    const body = JSON.stringify({ event: "card.created", pad: "x".repeat(1_048_576) });
    const response = await fetch(`${origin}/collabcast`, {
      method: "POST",
      headers: { "X-Collaboard-Signature": sign(Buffer.from(body)) },
      body,
    });
    // The refusal has to reach the client as a 413. A dropped connection would read
    // as a transport failure, and Collattice would retry a delivery that can never
    // succeed.
    assert.equal(response.status, 413);
    assert.equal((await response.text()).trim(), "payload too large");
  });
});

test("a 204 ack carries no body framing headers", async () => {
  await withServer(baseConfig, () => {}, async (origin) => {
    const body = JSON.stringify({ event: "card.created" });
    const response = await fetch(`${origin}/collabcast`, {
      method: "POST",
      headers: { "X-Collaboard-Signature": sign(Buffer.from(body)) },
      body,
    });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("content-length"), null);
    assert.equal(response.headers.get("content-type"), null);
  });
});

test("the wrong path and the wrong method are refused", async () => {
  await withServer(baseConfig, () => {}, async (origin) => {
    const wrongPath = await fetch(`${origin}/nope`, { method: "POST", body: "{}" });
    assert.equal(wrongPath.status, 404);

    const wrongMethod = await fetch(`${origin}/collabcast`, { method: "PUT", body: "{}" });
    assert.equal(wrongMethod.status, 405);
  });
});

test("healthz answers without a signature", async () => {
  await withServer(baseConfig, () => {}, async (origin) => {
    const response = await fetch(`${origin}/healthz`);
    assert.equal(response.status, 200);
    assert.equal((await response.text()).trim(), "ok");
  });
});

test("a handler that throws does not break the response", async () => {
  await withServer(baseConfig, () => {
    throw new Error("handler exploded");
  }, async (origin) => {
    const body = JSON.stringify({ event: "card.created" });
    const response = await fetch(`${origin}/collabcast`, {
      method: "POST",
      headers: { "X-Collaboard-Signature": sign(Buffer.from(body)) },
      body,
    });
    assert.equal(response.status, 204);
  });
});
