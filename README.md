<p align="center">
  <strong>collabcast</strong>
</p>

<p align="center">
  <strong>A bridge between Collattice board events and the systems you already use.</strong><br>
  Collattice posts an event. Collabcast decides who should hear about it, and tells them.<br>
  Single process. Zero runtime dependencies. No database, no queue, no cloud account.
</p>

<p align="center">
  <a href="https://github.com/Fanzoo/collabcast/actions/workflows/ci.yml"><img src="https://github.com/Fanzoo/collabcast/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-22%2B-339933" alt="Node 22+"></a>
  <a href="https://github.com/MrBildo/collattice"><img src="https://img.shields.io/badge/for-Collattice-512BD4" alt="For Collattice"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/Fanzoo/collabcast" alt="License"></a>
</p>

---

## What is Collabcast?

[Collattice](https://github.com/MrBildo/collattice) can POST a structured event to a URL
whenever something happens on a board — a card created, moved, or labeled; a comment
posted; a lane reordered — across a 22-event catalog. That's a clean signal. Turning it
into "tell my team in chat when a card lands in Ready" is still a small program someone
has to write, and then keep running.

Collabcast is that program, written once. It listens for Collattice webhook deliveries,
verifies them, decides which of them matter, and hands them to one or more **connectors**
that know how to talk to an outside system. **Matrix** is the first connector; the
architecture is built so it isn't the only one.

The design goal is that adding a destination means writing a connector, and changing
*what gets sent where* means editing config — not code.

## Features

- **The whole event catalog** — all 22 Collattice event types across cards, comments,
  labels, attachments, lanes, and boards, plus a `"*"` wildcard that picks up types added
  in future Collattice versions without a config change.
- **Routing instead of hard-coding** — a route matches on event type, board slug, the lane
  a card landed in, and whether a human or an agent caused it, then fans out to one or
  more targets. See [Routes](#routes).
- **Pluggable connectors** — a connector is one module exporting two functions. Matrix
  ships in the box; see [Writing a connector](docs/writing-a-connector.md).
- **Signature verification** — HMAC-SHA256 over the exact raw request bytes, compared in
  constant time. A delivery that doesn't verify is refused and never reaches a connector.
- **No secrets in the config file** — any value can be written `"env:NAME"` and is read
  from the environment at startup, so a real config is safe to commit. See
  [Keeping secrets out of the repo](#keeping-secrets-out-of-the-repo).
- **At-least-once delivery, absorbed** — events are deduplicated on Collattice's
  `eventId`, and connectors add a second idempotency layer where their destination offers
  one.
- **Acknowledge fast, forward after** — Collabcast answers Collattice immediately and
  delivers in the background, so a slow destination can never make Collattice retry.
- **Fails loud at startup** — the whole config is validated before the socket opens, and
  every problem is reported at once. `--check` does it without listening.
- **Zero runtime dependencies** — Node 22+ standard library only. Clone it and run it:
  nothing to `npm install` before it works, nothing in production to keep patched.
- **Typed, without a build step** — sources stay plain `.mjs`, and a hand-written
  [`types.d.ts`](types.d.ts) gives connector authors real autocomplete and `tsc`-checked
  contracts. TypeScript is a dev-only checker; it never runs and never ships.

## Quick Start

```bash
git clone https://github.com/Fanzoo/collabcast.git
cd collabcast
cp config.example.json config.json
```

Generate a signing secret and export it alongside your connector's credentials:

```bash
export COLLABCAST_SIGNING_SECRET=$(openssl rand -hex 32)
export MATRIX_ACCESS_TOKEN=syt_...
```

Edit `config.json` to point at your homeserver and room, then confirm it parses:

```bash
node src/index.mjs --check
```

```
config /path/to/config.json is valid
  listen      0.0.0.0:9080/collabcast
  signature   required
  deep links  http://collattice.example.org:8080
  target      team-chat (matrix)
  route       card activity: card.created,card.moved → team-chat
```

Start it:

```bash
node src/index.mjs
```

Then register the subscription in Collattice — **Admin → Webhooks**, or the
`create_webhook` MCP tool — pointing at your receiver with the *same* signing secret:

| | |
|---|---|
| URL | `http://your-host:9080/collabcast` |
| Events | `card.created`, `card.moved` |
| Secret | the value of `COLLABCAST_SIGNING_SECRET` |

Send a test delivery from that screen and watch the log. Before you pick that URL, read
[Reaching the receiver](#reaching-the-receiver) — the obvious choice is the one address
that can never work.

> For the full option-by-option reference see [Configuration](docs/configuration.md). For
> the Matrix bot, room, and access token walkthrough see
> [the Matrix connector](docs/connectors/matrix.md).

## How it works

```
Collattice
    │  POST /collabcast
    │  X-Collaboard-Event, X-Collaboard-Delivery-Id, X-Collaboard-Signature
    ▼
┌────────────────────────────────────────────────────────────┐
│ receiver    verify HMAC over raw bytes ──► 401 if it fails │
│             respond 204 ──────────────────► before any     │
│                                             forwarding     │
│ dedupe      seen this eventId before? ────► drop           │
│ router      which routes match? ──────────► which targets  │
│ summarize   one neutral description of the event           │
│ dispatch    send to each target, retry transient failures  │
└────────────────────────────────────────────────────────────┘
    │
    ├──► matrix connector ──► a room on your homeserver
    └──► (your connector)
```

Three decisions in there are worth explaining, because they're the ones that would
otherwise look arbitrary.

**The 204 comes before the delivery.** Collattice's per-POST delivery timeout is a few
seconds, and a slow endpoint is recorded as a *failed attempt* — which triggers retries.
If Collabcast waited on your homeserver before replying, a slow homeserver wouldn't just
delay a notification, it would produce **duplicate messages**. So the response goes out as
soon as the signature verifies. The cost is that a failed send is then Collabcast's to
own, which is what the retry loop in `dispatch` is for.

**Deduplication happens twice.** Collattice delivery is at-least-once and its `eventId` is
stable across retries, so the receiver keeps a bounded in-process memory of ids it has
seen. That set is lost on restart — so connectors add a second layer where their
destination supports one. The Matrix connector derives its transaction id from the
`eventId`, and Matrix makes a send idempotent per transaction id, so a duplicate is
collapsed by the homeserver even if Collabcast forgot about it.

**Nothing writes back to Collattice.** Every event carries an `actor.role`, and
Collattice's integration guide is emphatic about the loop you create when an automation
reacts to `card.created` by creating a card. Collabcast is a one-way bridge, so that loop
can't form, and it forwards agent-caused events by default with the actor marked. If you
write a connector that *does* write back to a board, set `humanActorsOnly` on its routes
first — see
[Writing a connector](docs/writing-a-connector.md#if-your-connector-writes-back).

## Configuration

Collabcast reads a single JSON file — `./config.json` by default, or `--config <path>`, or
`$COLLABCAST_CONFIG`. [`config.example.json`](config.example.json) is a working starting
point. The whole file is validated before the listener opens; a typo in an event name or a
route pointing at a target that doesn't exist is a startup error, not a silent no-op.

### Targets

A **target** is a named, configured destination — an instance of a connector. The name is
yours; it's what routes refer to.

```jsonc
// config.json
{
  "targets": {
    "team-chat": {
      "connector": "matrix",
      "homeserver": "http://127.0.0.1:8008",
      "accessToken": "env:MATRIX_ACCESS_TOKEN",
      "room": "#collattice:example.org"
    }
  }
}
```

Every target takes `connector` and an optional `enabled` (default `true`) — set it to
`false` to mute a destination without deleting its config. Everything else is the
connector's own options, validated by the connector.

### Routes

A **route** selects events and names the targets that should receive them. Every condition
in `when` must hold, and an omitted or empty condition means "no restriction on this axis".

```jsonc
// config.json
{
  "routes": [
    {
      "name": "card activity",
      "when": { "events": ["card.created", "card.moved"] },
      "to": ["team-chat"]
    },
    {
      "name": "ready for review",
      "when": {
        "events": ["card.moved"],
        "boards": ["research"],
        "enterLanes": ["Ready"],
        "humanActorsOnly": true
      },
      "to": ["team-chat", "on-call"]
    }
  ]
}
```

| Condition | Matches when |
|-----------|--------------|
| `events` | The event type is in the list. Use `"*"` for everything, including types added by future Collattice versions. Omitted or empty means every type. |
| `boards` | The event's `boardSlug` is in the list. A `webhook.ping` is not board-scoped and is never filtered out by this — otherwise the one tool for proving reachability would be the hardest thing to see. |
| `enterLanes` | The card came to rest in one of these lanes: the move target on `card.moved`, the resolved lane otherwise. Events with no lane never match. |
| `humanActorsOnly` | `actor.role` is `Administrator` or `HumanUser`. This is an allowlist of human roles rather than a denylist of agent roles, deliberately — the agent side already has two roles and the set can grow, so a denylist springs a leak the day a new one is added. |

Two routes naming the same target collapse to one delivery: a target hears about an event
once, however many routes selected it.

### Full settings reference

| Setting | Default | Description |
|---------|---------|-------------|
| `logLevel` | `info` | One of `error`, `warn`, `info`, `debug`. `debug` logs routing decisions and dropped duplicates — the level to use when an event isn't arriving where you expect. |
| `collattice.baseUrl` | *(unset)* | Your Collattice origin, e.g. `http://board.example.org:8080`. Optional, and purely cosmetic: when set, connectors that support rich output link card references straight to the card. Plain-text output is identical either way. |
| `listen.host` | `0.0.0.0` | Bind address. `0.0.0.0` accepts connections on every interface, which is usually what you want — see [Reaching the receiver](#reaching-the-receiver). |
| `listen.port` | `9080` | Bind port. Port `0` is rejected: Collattice has to dial this receiver, so a port nobody can predict is a misconfiguration, not a convenience. |
| `listen.path` | `/collabcast` | The path deliveries are accepted on. Any other path returns 404, so a stray scanner never reaches the pipeline. |
| `listen.maxBodyBytes` | `1048576` | Requests larger than this are refused with 413 instead of being buffered. |
| `signing.secret` | *(unset)* | The HMAC key, matching the secret on the Collattice subscription. When set, an unsigned or wrongly-signed delivery is refused with 401. When unset, deliveries are accepted unverified and Collabcast warns loudly at startup. Write it as `env:NAME`. |
| `delivery.attempts` | `4` | Send attempts per target per event, including the first. An error a connector marks permanent (a bad token, a room it can't post to) stops the retries early — retrying cannot fix either. |
| `delivery.backoffMs` | `1000` | Base wait before the first retry, doubling per attempt with jitter. A destination that says exactly how long to wait (Matrix's `retry_after_ms`) overrides this, up to a one-minute ceiling. |
| `dedupe.capacity` | `2048` | How many recent `eventId`s to remember. Large enough to absorb a retry storm; bounded so it can't grow without limit. |
| `targets` | *(required)* | Named destinations. See [Targets](#targets). |
| `routes` | *(required)* | Which events go where. See [Routes](#routes). |

### Keeping secrets out of the repo

Any string value anywhere in the config may be written `"env:NAME"`, and is replaced at
startup by that environment variable — failing loud, naming the variable, if it isn't set.

```jsonc
{
  "signing": { "secret": "env:COLLABCAST_SIGNING_SECRET" },
  "targets": {
    "team-chat": {
      "connector": "matrix",
      "accessToken": "env:MATRIX_ACCESS_TOKEN",
      "...": "..."
    }
  }
}
```

So the file names its secrets without holding them, and the process supplies the values.
That is what makes a real, working `config.json` safe to commit — and
`config.example.json` in this repo is exactly that shape.

Collabcast never logs a secret, a token, or an access key. `--check` prints *whether*
signature verification is on, never the secret itself.

## Reaching the receiver

Collattice refuses to deliver to private and internal addresses. There are two tiers, and
the distinction decides which URL you can use:

- **Re-permittable** — the RFC1918 LAN ranges (`10.0.0.0/8`, `172.16.0.0/12`,
  `192.168.0.0/16`) and IPv6 unique-local. Blocked by default; unblocked by setting
  `Webhooks__AllowPrivateNetworkTargets=true` on Collattice and restarting it.
- **Always blocked** — loopback (`127.0.0.0/8`, `::1`), link-local, unspecified, and
  multicast. **No setting re-opens these.**

> **The trap: `http://localhost:9080` can never work.** Running Collabcast on the same
> machine as Collattice is the normal deployment, which makes `localhost` the obvious URL
> — and it is in the always-blocked tier. Collattice rejects it when you create the
> subscription, and no amount of configuration changes that. It's a deliberate security
> property: turning the flag on to reach a host on your LAN can never also expose your own
> loopback services.

So address the receiver by something other than loopback, even when it's the same box:

| Where Collabcast runs | Use | Needs the Collattice flag? |
|---|---|---|
| A Tailscale host (`100.64.0.0/10`) | its `100.x` address or MagicDNS name | **No** — Collattice treats carrier-grade NAT as an ordinary target |
| The same LAN as Collattice | its LAN address or hostname | Yes |
| A public host | its hostname | No |

The Tailscale row is the cheapest answer for a self-hosted setup: a machine on your
tailnet is reachable at a `100.x` address Collattice delivers to with no config change and
no restart — *including when that machine is also the one running Collattice*. Keep
`listen.host` at `0.0.0.0` so the receiver accepts the connection on that interface.

Once it's wired, `GET /healthz` answers `ok` without a signature — handy for a
supervisor's health check.

## Upgrading from Collaboard

Collaboard was renamed to Collattice, and two things moved with it. Collabcast accepts both
spellings of each, so **an existing deployment keeps working across the upgrade** — but the old
names are the deprecated path, not a supported alternative.

**Delivery headers.** Collattice v3 sends `X-Collattice-Signature`, `X-Collattice-Event` and
`X-Collattice-Delivery-Id`; earlier versions sent `X-Collaboard-*`. Both are read, current name
first. Nothing to change.

Reading only the old names is how this broke once, and the failure is worth knowing: an
unrecognised signature header arrives as `undefined`, verification refuses it, and **every
delivery is answered 401**. The sender retries three times and drops the event. There is no
error anyone is watching on either side — the only symptom is chat going quiet, which reads as
*nothing happened on the board*. If messages stop after an upgrade, check the sender's
`failureCount` before assuming the board is idle.

**The config section.** `collaboard` became `collattice`:

```jsonc
{
  "collattice": { "baseUrl": "https://board.example.org" }
}
```

The old name still loads and emits a startup warning. Naming **both** is an error rather than a
precedence rule — a config carrying two different base URLs has no obviously correct reading, so
collabcast refuses to guess.

Nothing else changed. The 22-event catalog and the actor roles are identical across the rename.

## Connectors

| Connector | Sends to | Docs |
|-----------|----------|------|
| `matrix` | a room on a Matrix homeserver, via the client-server API | [docs/connectors/matrix.md](docs/connectors/matrix.md) |

Adding one is a module with a `validate` and an `open` function plus a line in the
registry — the full contract, with a worked example, is in
[Writing a connector](docs/writing-a-connector.md).

## Running as a service

Collabcast is a long-lived foreground process that logs to stdout and stops cleanly on
`SIGTERM`, so it fits any supervisor. On shutdown it closes the listener, waits up to ten
seconds for in-flight deliveries, then exits.

See [Deployment](docs/deployment.md) for ready-to-edit **launchd** (macOS) and **systemd**
(Linux) units, where to put credentials so they aren't world-readable, and the one thing
worth knowing about starting alongside Collattice: Collabcast comes up whether or not its
destinations are reachable yet, so start order never matters.

## What it guarantees, and what it doesn't

Worth being straight about, because it decides what you should build on top.

**It does** verify signatures before anything else; refuse anything that doesn't verify;
keep a destination's latency away from Collattice; deduplicate retries of the same event;
retry a destination that's temporarily down; and keep running when one is permanently
broken, saying so in the log.

**It doesn't** persist a queue. Events live in memory between arrival and delivery, so if
Collabcast is killed mid-flight, those events are gone. Collattice has the same property
one hop earlier — its delivery queue is in memory, and an event pending when the API
restarts is dropped without even a failed-attempt row in its delivery log.

Which means: **this is a notifier, not an audit log.** At small scale that's a fine trade —
the card is sitting right there on the board — but don't build something downstream that
assumes it saw everything.

## Development

```bash
node --version   # 22 or newer
npm test         # runs with nothing installed
```

```bash
npm ci             # the dev toolchain: typescript, @types/node
npm run typecheck  # tsc --noEmit over the .mjs sources
npm run verify     # typecheck + test
```

The test suite covers signature verification (including that a re-serialized body must
*not* verify), route matching, the summarizer across every event family, config validation,
the retry and dedupe logic, and an end-to-end test that runs the real process against a stub
homeserver and asserts on the message that comes out.

```
src/
  index.mjs           startup, wiring, shutdown
  config.mjs          load, resolve env: references, validate
  receiver.mjs        HTTP surface, HMAC verification
  dedupe.mjs          bounded memory of seen event ids
  event.mjs           normalize a delivery; render a neutral summary
  router.mjs          match events to targets
  dispatch.mjs        send with bounded retry
  events.mjs          the Collattice event catalog
  connectors/
    index.mjs         the registry
    matrix.mjs        the Matrix connector
types.d.ts            the type contract — events, summaries, the connector interface
```

### Types without a build step

The sources are JavaScript and run directly; `types.d.ts` is hand-written, and `tsconfig.json`
turns on `checkJs` so TypeScript checks the `.mjs` files against it. Nothing is compiled,
nothing is emitted, and `node src/index.mjs` never needs the toolchain.

Reference a type from JSDoc like this — `../types.js` resolves to the declaration file, and
there is no `types.js`:

```js
/** @type {import("../types.js").DeliveryError} */
const error = new Error("rate limited");
error.retryAfterMs = 3000;
```

Two settings are deliberately relaxed from `strict`, both documented in `tsconfig.json`:
`noImplicitAny` (annotating every parameter produced 84 mechanical errors and found no
defects) and `useUnknownInCatchVariables` (everything here throws an `Error`, so the
narrowing dance is noise). The checks that earn their keep — shapes, nullability, and
conformance to the connector interface — are all on.

## License

[MIT](LICENSE)
