import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";

/**
 * End-to-end: a signed Collattice delivery arrives at a real Collabcast process and
 * comes out the other side as a Matrix message, verified against a stub homeserver.
 */

const SECRET = "0123456789abcdef0123456789abcdef";
const ENTRY = new URL("../src/index.mjs", import.meta.url).pathname;
const sign = (body) => `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;

/** A minimal stand-in for the handful of Matrix endpoints the connector touches. */
function stubHomeserver() {
  const sends = [];
  const server = createServer((req, res) => {
    const json = (status, body) => {
      const text = JSON.stringify(body);
      res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
      res.end(text);
    };

    const path = req.url ?? "/";

    if (path.startsWith("/_matrix/client/v3/account/whoami")) {
      json(200, { user_id: "@collabcast:example.org" });
      return;
    }
    if (path.startsWith("/_matrix/client/v3/directory/room/")) {
      json(200, { room_id: "!resolved:example.org" });
      return;
    }
    if (req.method === "PUT" && path.includes("/send/m.room.message/")) {
      /** @type {Buffer[]} */
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        sends.push({
          url: path,
          auth: req.headers.authorization,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        });
        json(200, { event_id: `$evt${sends.length}` });
      });
      return;
    }
    json(404, { errcode: "M_UNRECOGNIZED", error: "stub does not implement this" });
  });
  return { server, sends };
}

async function listen(server) {
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return server.address().port;
}

/**
 * Collabcast rejects port 0 on purpose — Collattice has to dial the receiver, so a
 * port nobody can predict is a misconfiguration. Borrow a real free port instead.
 */
async function freePort() {
  const probe = createServer();
  const port = await listen(probe);
  await new Promise((done) => probe.close(done));
  return port;
}

/** Start collabcast and resolve once it reports that it is listening. */
async function startBridge(configPath) {
  const child = spawn(process.execPath, [ENTRY, "--config", configPath], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, COLLABCAST_SIGNING_SECRET: SECRET, MATRIX_ACCESS_TOKEN: "syt_stub_token" },
  });

  const output = [];
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => output.push(chunk));
  }

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (output.join("").includes("listening")) return { child, output };
    if (child.exitCode !== null) {
      throw new Error(`collabcast exited early (${child.exitCode}):\n${output.join("")}`);
    }
    await new Promise((done) => setTimeout(done, 50));
  }
  child.kill("SIGKILL");
  throw new Error(`collabcast never reported listening:\n${output.join("")}`);
}

async function stopBridge(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), new Promise((done) => setTimeout(done, 5_000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

/** Wait for a condition the bridge satisfies asynchronously, after it has 204'd. */
async function eventually(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((done) => setTimeout(done, 25));
  }
  return false;
}

const post = (origin, payload) => {
  const body = JSON.stringify(payload);
  return fetch(`${origin}/collabcast`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "Collattice-Webhooks",
      "X-Collaboard-Event": payload.event,
      "X-Collaboard-Delivery-Id": payload.eventId,
      "X-Collaboard-Signature": sign(Buffer.from(body)),
    },
    body,
  });
};

const cardMoved = (eventId) => ({
  event: "card.moved",
  eventId,
  occurredAt: "2026-06-18T16:42:25.770Z",
  version: "1",
  boardId: "f6fa6794-4bed-44d0-9656-de8080791302",
  boardSlug: "research",
  actor: { userId: "52df8c11", name: "Alex Rivera", role: "HumanUser" },
  data: {
    card: { id: "a1b2", number: 321, name: "Investigate flaky test" },
    laneName: "Ready",
    from: { laneId: "1", laneName: "Doing", position: 3 },
    to: { laneId: "2", laneName: "Ready", position: 0 },
  },
});

test("a signed delivery becomes a Matrix message", async (t) => {
  const { server, sends } = stubHomeserver();
  const homeserverPort = await listen(server);
  t.after(() => new Promise((done) => server.close(done)));

  const dir = await mkdtemp(join(tmpdir(), "collabcast-e2e-"));
  const configPath = join(dir, "config.json");
  const bridgePort = await freePort();
  await writeFile(
    configPath,
    JSON.stringify({
      logLevel: "debug",
      collattice: { baseUrl: "http://board.example.org:8080" },
      listen: { host: "127.0.0.1", port: bridgePort, path: "/collabcast" },
      signing: { secret: "env:COLLABCAST_SIGNING_SECRET" },
      delivery: { attempts: 2, backoffMs: 10 },
      targets: {
        "team-chat": {
          connector: "matrix",
          homeserver: `http://127.0.0.1:${homeserverPort}`,
          accessToken: "env:MATRIX_ACCESS_TOKEN",
          room: "#collabcast:example.org",
        },
      },
      routes: [
        { name: "card activity", when: { events: ["card.created", "card.moved"] }, to: ["team-chat"] },
        { name: "comments", when: { events: ["comment.created"], humanActorsOnly: true }, to: ["team-chat"] },
      ],
    }),
  );

  const { child, output } = await startBridge(configPath);
  t.after(() => stopBridge(child));

  const origin = `http://127.0.0.1:${bridgePort}`;
  assert.match(output.join(""), new RegExp(`url=http://127\\.0\\.0\\.1:${bridgePort}/collabcast`));

  await t.test("preflight resolved the room alias and the bot identity", async () => {
    // Preflight runs after the listener binds and does not block it, so these lines
    // land shortly *after* "listening" rather than before it — waiting for them is
    // the point, not an incidental convenience.
    const log = () => output.join("");
    assert.ok(await eventually(() => /resolved room alias/.test(log())), `preflight never resolved the alias:\n${log()}`);
    assert.match(log(), /@collabcast:example\.org/);
  });

  await t.test("card.moved is delivered with both lane names and a deep link", async () => {
    const response = await post(origin, cardMoved("01J9ZQK8H6F4N3M2P7R5T8V0XW"));
    assert.equal(response.status, 204);

    assert.ok(await eventually(() => sends.length === 1), `no message reached the homeserver:\n${output.join("")}`);
    const [sent] = sends;
    assert.equal(sent.auth, "Bearer syt_stub_token");
    // encodeURIComponent leaves "!" alone (a valid path sub-delimiter) but escapes ":".
    assert.match(sent.url, /\/rooms\/!resolved%3Aexample\.org\/send\/m\.room\.message\//);
    assert.equal(sent.body.msgtype, "m.notice");
    assert.equal(
      sent.body.body,
      "➡️ [research] moved #321 Investigate flaky test from Doing to Ready · Alex Rivera",
    );
    assert.match(sent.body.formatted_body, /<a href="http:\/\/board\.example\.org:8080\/boards\/research\/cards\/321">/);
  });

  await t.test("the transaction id is derived from the event id", () => {
    assert.match(sends[0].url, /01J9ZQK8H6F4N3M2P7R5T8V0XW/);
  });

  await t.test("a replayed delivery is deduplicated", async () => {
    const response = await post(origin, cardMoved("01J9ZQK8H6F4N3M2P7R5T8V0XW"));
    assert.equal(response.status, 204);
    // Give the bridge a moment to prove it does *not* send again.
    await new Promise((done) => setTimeout(done, 300));
    assert.equal(sends.length, 1, "a repeated eventId must not produce a second message");
  });

  await t.test("an event no route selects is dropped", async () => {
    const response = await post(origin, {
      event: "label.created",
      eventId: "01JLABEL",
      boardSlug: "research",
      actor: { name: "Alex Rivera", role: "HumanUser" },
      data: { label: { name: "Bug" } },
    });
    assert.equal(response.status, 204);
    await new Promise((done) => setTimeout(done, 300));
    assert.equal(sends.length, 1);
  });

  await t.test("humanActorsOnly keeps an agent comment out", async () => {
    const response = await post(origin, {
      event: "comment.created",
      eventId: "01JCOMMENT",
      boardSlug: "research",
      actor: { name: "Scout", role: "AgentUser" },
      data: { comment: { contentMarkdown: "automated note" }, card: { number: 321 } },
    });
    assert.equal(response.status, 204);
    await new Promise((done) => setTimeout(done, 300));
    assert.equal(sends.length, 1, "an agent-authored comment must not pass a humanActorsOnly route");
  });

  await t.test("a tampered body is refused and never forwarded", async () => {
    const body = JSON.stringify(cardMoved("01JTAMPERED"));
    const response = await fetch(`${origin}/collabcast`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Collaboard-Signature": sign(Buffer.from("something else")) },
      body,
    });
    assert.equal(response.status, 401);
    await new Promise((done) => setTimeout(done, 200));
    assert.equal(sends.length, 1);
  });
});
