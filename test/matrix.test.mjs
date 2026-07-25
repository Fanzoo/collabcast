import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { open } from "../src/connectors/matrix.mjs";
import { normalize, summarize } from "../src/event.mjs";

const silent = { info() {}, warn() {}, error() {}, debug() {}, child: () => silent };

/** A stub homeserver that records the message bodies the connector PUTs to it. */
async function stubHomeserver() {
  const sends = [];
  const server = createServer((req, res) => {
    const json = (status, body) => {
      const text = JSON.stringify(body);
      res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
      res.end(text);
    };
    if (req.method === "PUT" && (req.url ?? "").includes("/send/m.room.message/")) {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        sends.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        json(200, { event_id: `$evt${sends.length}` });
      });
      return;
    }
    json(404, { errcode: "M_UNRECOGNIZED", error: "stub does not implement this" });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", () => done(null)));
  const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
  return { server, sends, origin: `http://127.0.0.1:${port}` };
}

test("everything interpolated into formatted_body is escaped", async (t) => {
  const { server, sends, origin } = await stubHomeserver();
  t.after(() => new Promise((done) => server.close(done)));

  const instance = open(
    { homeserver: origin, accessToken: "syt_stub", room: "!room:example.org", includeOccurredAt: true },
    { name: "chat", log: silent },
  );

  // occurredAt is delivery data like every other field, and the rich body is HTML.
  const hostile = '2026-06-18T16:42:25.770Z<img src=x onerror="alert(1)">';
  const event = normalize({
    event: "card.created",
    eventId: "01J",
    occurredAt: hostile,
    boardSlug: "research",
    data: { card: { number: 1, name: "A card" } },
  });
  await instance.send({ event, summary: summarize(event) });

  assert.equal(sends.length, 1);
  const [sent] = sends;
  assert.ok(sent.body.includes(hostile), "the plain-text form carries the value as-is");
  assert.ok(!sent.formatted_body.includes("<img"), `unescaped markup reached the room: ${sent.formatted_body}`);
  assert.ok(sent.formatted_body.includes("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"));
});
