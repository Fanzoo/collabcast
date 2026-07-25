# Writing a connector

A **connector** is a module that knows how to deliver a Collaboard event to one outside
system. A **target** is a named, configured instance of one. Collabcast's core handles
receiving, verifying, deduplicating, routing, and retrying — a connector's only job is to
take one event and put it somewhere.

The contract is two exported functions and a line in the registry.

It's also fully typed. The sources are plain JavaScript with no build step, but
[`types.d.ts`](../types.d.ts) declares the whole interface, so a JSDoc annotation gets you
autocomplete and real errors in your editor — a `send` you spelled `deliver`, a property
that isn't on the event, a `preflight` returning the wrong shape.

---

## The contract

```js
// src/connectors/example.mjs

/** The value operators write as `"connector": "..."` in a target. */
export const id = "example";

/** A human-readable name, for logs and docs. */
export const label = "Example";

/**
 * Throw an Error if these options can't work. Called once at startup, before the
 * listener opens, so a misconfigured target is a startup failure rather than a
 * surprise the first time a card moves.
 *
 * @param {Record<string, any>} options
 * @param {Pick<import("../../types.js").ConnectorContext, "name">} ctx
 * @returns {void}
 */
export function validate(options, ctx) {
  if (!options.url) throw new Error(`targets.${ctx.name}: "url" is required`);
}

/**
 * Return the live instance. Called once per enabled target at startup.
 *
 * @param {Record<string, any>} options
 * @param {import("../../types.js").ConnectorContext} ctx
 * @returns {import("../../types.js").ConnectorInstance}
 */
export function open(options, ctx) {
  return {
    async preflight() {
      // Optional. Check credentials and log something useful.
      return { account: "..." };
    },

    async send({ event, summary }) {
      // Deliver, or throw. Throwing is how you ask for a retry.
    },
  };
}
```

`ctx` carries `{ name, log }` — the target's configured name, and a logger already stamped
with it, so `ctx.log.info("something")` comes out attributed to the right target.

The `@returns {ConnectorInstance}` annotation is the one worth copying. It's what makes the
checker verify your returned object against the interface, so `npm run typecheck` catches a
misnamed method before you ever wire up a subscription. `../types.js` resolves to the
declaration file; there is no `types.js`.

### `validate(options, ctx)`

`options` is the target's config with `connector` and `enabled` removed — everything else,
already resolved, so an `"env:NAME"` value arrives as the value it referenced.

Check everything you can here and throw with a message that names the offending key.
Collabcast collects failures across all targets and routes and reports them together, so an
operator fixing a config sees every problem in one pass instead of one per restart. Prefix
messages with `targets.${ctx.name}:` to match the rest of the output.

### `open(options, ctx)`

Called once per enabled target. Build whatever you need — a resolved id, a cached handle —
and return an object with `send`, optionally `preflight`.

### `preflight()`

Optional, and **best-effort by design**. Use it to verify credentials and log what you
resolved. If it throws, Collabcast logs a warning and *starts anyway*: the bridge and its
destinations frequently come up at the same moment, and a destination that isn't ready yet
must not stop the receiver from accepting events. Don't put anything load-bearing here.

### `send({ event, summary })`

The whole job. Return normally on success; throw to ask for a retry.

`summary` is a connector-neutral rendering of the event, so a simple connector doesn't have
to think about formatting:

```js
{
  icon: "➡️",
  text: "[research] moved #321 Investigate flaky test from Doing to Ready · Alex Rivera",
  html: "[<b>research</b>] moved <a href=\"...\">#321 Investigate flaky test</a> from <b>Doing</b> to <b>Ready</b> · <i>Alex Rivera</i>"
}
```

`event` is the normalized delivery, for when the summary isn't enough:

```js
{
  id: "01J9ZQK8H6F4N3M2P7R5T8V0XW",   // ULID, stable across Collaboard retries
  type: "card.moved",
  version: "1",
  occurredAt: "2026-06-18T16:42:25.770Z",
  board: { id: "f6fa...", slug: "research" },   // both null on a ping
  actor: { id: "52df...", name: "Alex Rivera", role: "Administrator", isHuman: true },
  data: { /* the per-event payload, exactly as Collaboard sent it */ },
  raw:  { /* the entire original body */ },
}
```

`data` and `raw` are passed through untouched, so anything the normalizer didn't lift out is
still reachable.

## Controlling retries

Throwing asks for a retry. Two properties on the error let you say more — annotate it as a
`DeliveryError` and both are checked:

```js
/** @type {import("../../types.js").DeliveryError} */
const error = new Error("rate limited");
error.retryAfterMs = 3000;   // wait exactly this long instead of the computed backoff
throw error;
```

```js
/** @type {import("../../types.js").DeliveryError} */
const error = new Error("token rejected");
error.permanent = true;      // don't retry at all — retrying can't fix this
throw error;
```

Mark `permanent` for anything an operator has to fix: a bad credential, a destination that
refuses this account, a malformed request. Without it, a broken token produces
`delivery.attempts` identical failures per event and buries the real cause in noise.

Use `retryAfterMs` whenever the destination tells you how long to wait. Guessing when you've
been told is how you get rate-limited twice.

Everything else — connection refused, DNS failure, timeout, a 5xx — should be a plain
`throw`, and the caller applies exponential backoff with jitter.

## Register it

```js
// src/connectors/index.mjs
import * as matrix from "./matrix.mjs";
import * as example from "./example.mjs";

const registry = new Map([
  [matrix.id, matrix],
  [example.id, example],
]);
```

That's the whole wiring. `validate` now runs for any target naming it, `--check` lists it,
and an unknown-connector error names it among the valid ones.

## Test it

Connectors are plain modules, so `open()` one and call `send` directly. For anything that
talks HTTP, a stub server is enough and keeps the suite offline —
[`test/integration.test.mjs`](../test/integration.test.mjs) does exactly this for Matrix:
stands up a stub homeserver, runs the real Collabcast process against it, and asserts on
the request that arrives. Copy that shape.

```bash
npm run verify   # typecheck + test
```

Run the typecheck before the tests: a connector whose `send` doesn't match the interface
fails there instantly, whereas a test would only catch it once you'd written enough of a
harness to call it.

---

## If your connector writes back

Everything above assumes a one-way connector: Collaboard event in, message out. If you
write one that **creates or modifies Collaboard cards**, read this first.

An automation that reacts to `card.created` by creating a card is a loop. The card it
creates fires its own `card.created`, which triggers the automation, which creates another.
Collaboard's integration guide is blunt that with agents in the mix this is a *when*, not an
*if*.

The break is `actor.role`, and Collabcast already implements it — put `humanActorsOnly` on
every route feeding such a connector:

```jsonc
{
  "name": "mirror to tracker",
  "when": { "events": ["card.created"], "humanActorsOnly": true },
  "to": ["tracker"]
}
```

That's an **allowlist** of the two human roles (`Administrator`, `HumanUser`), not a
denylist of agent roles — which is the point. The agent side already has two roles today,
and a denylist naming `AgentUser` silently lets an `AgentAdministrator` through, then springs
a fresh leak the day a new agent role is added. `event.actor.isHuman` on the normalized event
is computed the same way; use it rather than comparing role strings yourself.

Also give the connector its own Collaboard user with an agent role, so the events it causes
are attributable and distinguishable from a person's.
