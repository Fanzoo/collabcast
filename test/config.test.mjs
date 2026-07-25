import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../src/config.mjs";

const SECRET = "0123456789abcdef0123456789abcdef";

const valid = {
  signing: { secret: SECRET },
  targets: {
    chat: {
      connector: "matrix",
      homeserver: "http://127.0.0.1:8008",
      accessToken: "syt_example_token",
      room: "!abc:example.org",
    },
  },
  routes: [{ name: "cards", when: { events: ["card.created", "card.moved"] }, to: ["chat"] }],
};

async function write(config) {
  const dir = await mkdtemp(join(tmpdir(), "collabcast-test-"));
  const path = join(dir, "config.json");
  await writeFile(path, typeof config === "string" ? config : JSON.stringify(config));
  return path;
}

const rejects = (path, pattern) => assert.rejects(() => loadConfig(path), pattern);

test("a valid config loads and picks up defaults", async () => {
  const config = await loadConfig(await write(valid));
  assert.equal(config.listen.port, 9080);
  assert.equal(config.listen.path, "/collabcast");
  assert.equal(config.delivery.attempts, 4);
  assert.equal(config.targets.chat.connectorId, "matrix");
  assert.equal(config.targets.chat.enabled, true);
  assert.equal(config.routes[0].when.humanActorsOnly, false);
  assert.deepEqual(config.warnings, []);
});

test("env: references are resolved from the environment", async () => {
  process.env.COLLABCAST_TEST_TOKEN = "syt_from_env";
  try {
    const config = await loadConfig(
      await write({
        ...valid,
        targets: { chat: { ...valid.targets.chat, accessToken: "env:COLLABCAST_TEST_TOKEN" } },
      }),
    );
    assert.equal(config.targets.chat.options.accessToken, "syt_from_env");
  } finally {
    delete process.env.COLLABCAST_TEST_TOKEN;
  }
});

test("an unset env: reference fails loud and names the variable", async () => {
  delete process.env.COLLABCAST_MISSING_VAR;
  const path = await write({
    ...valid,
    targets: { chat: { ...valid.targets.chat, accessToken: "env:COLLABCAST_MISSING_VAR" } },
  });
  await rejects(path, /COLLABCAST_MISSING_VAR is not set/);
});

test("a missing file and malformed JSON both report clearly", async () => {
  await rejects(join(tmpdir(), "collabcast-does-not-exist", "config.json"), /cannot read config/);
  await rejects(await write("{ not json"), /not valid JSON/);
});

test("an unknown connector lists the ones that exist", async () => {
  const path = await write({ ...valid, targets: { chat: { connector: "carrier-pigeon" } } });
  await rejects(path, /known connectors: matrix/);
});

test("a route pointing at an undefined target is rejected", async () => {
  const path = await write({ ...valid, routes: [{ when: { events: ["card.created"] }, to: ["nowhere"] }] });
  await rejects(path, /names "nowhere", which is not defined in targets/);
});

test("an unknown event type is rejected", async () => {
  const path = await write({ ...valid, routes: [{ when: { events: ["card.exploded"] }, to: ["chat"] }] });
  await rejects(path, /unknown event type "card\.exploded"/);
});

test("empty targets and empty routes are rejected", async () => {
  await rejects(await write({ ...valid, targets: {} }), /targets must be a non-empty object/);
  await rejects(await write({ ...valid, routes: [] }), /routes must be a non-empty array/);
});

test("a short signing secret is rejected", async () => {
  await rejects(await write({ ...valid, signing: { secret: "tooshort" } }), /at least 16 characters/);
});

test("omitting the signing secret loads but warns", async () => {
  const config = await loadConfig(await write({ ...valid, signing: {} }));
  assert.equal(config.signing.secret, null);
  assert.match(config.warnings.join(" "), /without signature verification/);
});

test("connector options are validated by the connector", async () => {
  await rejects(
    await write({ ...valid, targets: { chat: { ...valid.targets.chat, room: "not-a-room" } } }),
    /"room" must be a room id/,
  );
  await rejects(
    await write({ ...valid, targets: { chat: { ...valid.targets.chat, homeserver: "ftp://example.org" } } }),
    /must be http or https/,
  );
  await rejects(
    await write({ ...valid, targets: { chat: { ...valid.targets.chat, accessToken: "" } } }),
    /"accessToken" is required/,
  );
});

test("all problems are reported at once, not one per run", async () => {
  const path = await write({
    ...valid,
    listen: { port: 99999 },
    routes: [{ when: { events: ["card.nope"] }, to: ["missing"] }],
  });
  const error = await loadConfig(path).then(
    () => null,
    (e) => e,
  );
  assert.ok(error, "expected a rejection");
  assert.match(error.message, /listen\.port/);
  assert.match(error.message, /card\.nope/);
  assert.match(error.message, /missing/);
});

test("a disabled target warns the routes that point only at it", async () => {
  const config = await loadConfig(
    await write({ ...valid, targets: { chat: { ...valid.targets.chat, enabled: false } } }),
  );
  assert.match(config.warnings.join(" "), /points only at disabled targets/);
});

test("collaboard.baseUrl is optional and normalized", async () => {
  const off = await loadConfig(await write(valid));
  assert.equal(off.collaboard.baseUrl, null);

  const on = await loadConfig(await write({ ...valid, collaboard: { baseUrl: "http://board.example.org:8080/" } }));
  assert.equal(on.collaboard.baseUrl, "http://board.example.org:8080");

  await rejects(await write({ ...valid, collaboard: { baseUrl: "nonsense" } }), /not a valid URL/);
});

test("the shipped example config is valid", async () => {
  process.env.COLLABCAST_SIGNING_SECRET = SECRET;
  process.env.MATRIX_ACCESS_TOKEN = "syt_example_token";
  try {
    const config = await loadConfig(new URL("../config.example.json", import.meta.url).pathname);
    assert.equal(config.targets["team-chat"].connectorId, "matrix");
    assert.deepEqual(config.routes[0].when.events, ["card.created", "card.moved"]);
  } finally {
    delete process.env.COLLABCAST_SIGNING_SECRET;
    delete process.env.MATRIX_ACCESS_TOKEN;
  }
});
