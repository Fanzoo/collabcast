# Configuration

Collabcast is configured by one JSON file. There are no command-line equivalents for
individual settings and no partial overrides — the file is the whole configuration, which
means the file is also the whole answer to "what is this thing doing?".

```bash
node src/index.mjs                              # ./config.json
node src/index.mjs --config /etc/collabcast.json # an explicit path
COLLABCAST_CONFIG=/etc/collabcast.json node src/index.mjs
```

Precedence: `--config` wins, then `$COLLABCAST_CONFIG`, then `./config.json`.

## Validate before you run

```bash
node src/index.mjs --check
```

`--check` loads and validates everything — including each connector's own options — then
prints what it resolved and exits without opening a socket. It's safe to run against a live
config; it connects to nothing.

```
config /Users/you/.collabcast/config.json is valid
  listen      0.0.0.0:9080/collabcast
  signature   required
  deep links  https://board.example.org
  target      team-chat (matrix)
  target      on-call (matrix, disabled)
  route       card activity: card.created,card.moved → team-chat
  route       escalations: card.moved [boards=ops enterLanes=Blocked] → team-chat, on-call
```

Validation is **all-at-once**: every problem is reported in one pass rather than one per
restart.

```
invalid configuration:
  - listen.port must be an integer between 1 and 65535 — got 99999
  - routes[0].when.events contains unknown event type "card.move"
  - routes[1].to names "slack", which is not defined in targets
```

Nothing is validated lazily and nothing is validated at delivery time, so a config that
starts is a config whose shape is already known good. What can still fail later is the
world outside: a revoked token, a room the bot was removed from, a homeserver that's down.

---

## The whole file

```jsonc
// config.json — every key, with its default where there is one
{
  "logLevel": "info",

  "collaboard": {
    "baseUrl": "https://board.example.org"
  },

  "listen": {
    "host": "0.0.0.0",
    "port": 9080,
    "path": "/collabcast",
    "maxBodyBytes": 1048576
  },

  "signing": {
    "secret": "env:COLLABCAST_SIGNING_SECRET"
  },

  "delivery": {
    "attempts": 4,
    "backoffMs": 1000
  },

  "dedupe": {
    "capacity": 2048
  },

  "targets": {
    "team-chat": {
      "connector": "matrix",
      "enabled": true,
      "homeserver": "https://matrix.example.org",
      "accessToken": "env:MATRIX_ACCESS_TOKEN",
      "room": "#collaboard:example.org"
    }
  },

  "routes": [
    {
      "name": "card activity",
      "when": {
        "events": ["card.created", "card.moved"],
        "boards": [],
        "enterLanes": [],
        "humanActorsOnly": false
      },
      "to": ["team-chat"]
    }
  ]
}
```

Only `targets` and `routes` are required. Everything else has a working default, except
`signing.secret` — which has no default because there's no safe one to pick, and
`collaboard.baseUrl`, which is purely cosmetic.

The per-setting reference table lives in
[the README](../README.md#full-settings-reference). What follows is the parts that need more
than a table cell.

---

## `env:` references

Any string value, anywhere in the file, may be written `"env:NAME"`. At startup it is
replaced by that environment variable's value.

```jsonc
{
  "signing": { "secret": "env:COLLABCAST_SIGNING_SECRET" },
  "targets": {
    "team-chat": { "connector": "matrix", "accessToken": "env:MATRIX_ACCESS_TOKEN", "...": "..." }
  }
}
```

An unset or empty variable is a startup failure that names it:

```
config is invalid: targets.team-chat.accessToken is "env:MATRIX_ACCESS_TOKEN",
but the environment variable MATRIX_ACCESS_TOKEN is not set
```

Failing loud is the point. The alternative — treating a missing secret as "no secret" — would
silently drop signature verification, or authenticate as nobody, and the first sign of trouble
would be an integration that quietly stopped working.

Three things worth knowing:

- **It's a whole-value form, not interpolation.** `"env:TOKEN"` works;
  `"Bearer env:TOKEN"` and `"${TOKEN}"` do not — they're treated as literal strings.
- **It applies everywhere**, not just to fields that look secret. `"port"` can't use it (it
  isn't a string), but any string can.
- **A literal value starting with `env:` isn't expressible.** No real credential looks like
  that, so this hasn't been worth an escape hatch.

For where to put the environment itself under a supervisor, see
[Deployment](deployment.md#before-you-start-the-secrets).

## `signing.secret`

The HMAC key, which must match the secret on the Collaboard subscription exactly. Generate
one:

```bash
openssl rand -hex 32
```

When it's set, every delivery must carry a valid `X-Collaboard-Signature` or it's refused
with `401` before being parsed, and never reaches a connector. Collabcast verifies the digest
over **the exact bytes that arrived** — not a re-serialized copy of the parsed body, which
would reorder keys or change whitespace and fail to match a genuine payload. There's a test
asserting precisely that.

When it's unset, deliveries are accepted unverified and Collabcast warns at startup:

```
[WRN] no signing.secret configured — deliveries are accepted without signature verification.
      Set a secret here and on the Collaboard subscription.
```

That's supported for a first five minutes on a trusted network, but anyone who can reach the
port can post anything into your chat room. Set a secret.

A secret shorter than 16 characters is rejected outright rather than accepted weakly.

## `listen`

`host` defaults to `0.0.0.0` so the receiver answers on every interface. That is almost
always what you want, because the address Collaboard is allowed to dial usually isn't
loopback — see [Reaching the receiver](../README.md#reaching-the-receiver).

`port` **rejects 0.** In most servers 0 means "let the OS choose", but Collaboard has to dial
this receiver at a URL you registered in advance, so an unpredictable port is a
misconfiguration rather than a convenience.

`path` is matched exactly; anything else gets a `404` without being read. `GET /healthz` is
the one other route, needs no signature, and answers `ok`.

## `delivery`

`attempts` counts the first try, so `4` means one attempt and three retries. Waits grow
exponentially from `backoffMs` with jitter, so several queued retries don't all fire in the
same millisecond when a destination recovers.

Two things shorten that loop:

- A connector can mark an error **permanent** — a rejected token, a room it can't post to —
  and the remaining attempts are skipped. Retrying can't fix those, and without this a bad
  credential produces `attempts` identical failures per event and buries the cause.
- A destination that says exactly how long to wait (Matrix's `retry_after_ms`) **overrides**
  the computed backoff. Being told and then guessing is how you get rate-limited twice. The
  value is capped at one minute: it comes from the other end of the connection, and a
  destination asking for an hour would park the delivery — and everything queued behind it —
  for an hour.

This retry loop exists because Collabcast acknowledges Collaboard *before* forwarding. That
ordering keeps a slow destination from making Collaboard retry — which would duplicate
messages — but it transfers ownership of a failed send to Collabcast. Retries are the other
half of that trade. See
[How it works](../README.md#how-it-works).

## `dedupe.capacity`

How many recent `eventId`s to remember. Collaboard delivery is at-least-once and the id is
stable across retries of one event, so this absorbs re-deliveries.

The default 2048 is far more than a retry storm needs. It's bounded on purpose, so a
long-running process can't grow without limit, and it's in-process on purpose: connectors add
a second idempotency layer where their destination offers one, which is what actually covers
the restart case.

---

## Routing recipes

The condition-by-condition reference is in [the README](../README.md#routes). These are the
shapes that come up in practice.

**Everything, everywhere** — the firehose. Useful for a private feed, or for seeing what a
board actually emits before you decide what you care about.

```jsonc
{ "name": "firehose", "when": { "events": ["*"] }, "to": ["team-chat"] }
```

`"*"` also picks up event types added in future Collaboard versions with no config change. An
event type this build has never seen still renders, using its type name.

**Only the transitions that matter** — quieter than every move.

```jsonc
{
  "name": "reached a milestone",
  "when": { "events": ["card.moved"], "enterLanes": ["Ready", "Done", "Blocked"] },
  "to": ["team-chat"]
}
```

`enterLanes` matches the lane the card came to rest in — `to.laneName` on a move. Moves into
other lanes are silent. Note that reordering a card *within* a lane doesn't emit
`card.moved` at all, so it can't reach a route regardless.

**Keep scratch boards out of chat.**

```jsonc
{
  "name": "real boards only",
  "when": { "events": ["card.created", "card.moved"], "boards": ["research", "website"] },
  "to": ["team-chat"]
}
```

`boards` matches `boardSlug`, which rides in every event body — no lookup, no board ids in
your config. A `webhook.ping` is deliberately exempt: it isn't board-scoped, so a board filter
never hides it, and the one tool for proving reachability stays visible.

**Humans only** — drops anything an agent caused.

```jsonc
{
  "name": "people, not bots",
  "when": { "events": ["card.created"], "humanActorsOnly": true },
  "to": ["team-chat"]
}
```

Leave it off (the default) and agent activity is forwarded too, marked `(agent)` in the
message — which is usually what you want on a board where humans and agents both work. Turn it
on for a low-noise channel, and **always** turn it on for a connector that writes back to a
board: see
[If your connector writes back](writing-a-connector.md#if-your-connector-writes-back).

**Different destinations for different urgency** — one route per audience, not one route with
branching.

```jsonc
"routes": [
  {
    "name": "normal activity",
    "when": { "events": ["card.created", "card.moved"] },
    "to": ["team-chat"]
  },
  {
    "name": "blocked work",
    "when": { "events": ["card.moved"], "enterLanes": ["Blocked"] },
    "to": ["team-chat", "on-call"]
  }
]
```

A card moving into Blocked matches both routes. `team-chat` is named by both and still gets
**one** message — a target hears about an event once, however many routes selected it. `on-call`
gets it too. That's the composition model: routes add audiences, they don't multiply messages.

**Mute a destination without deleting it.**

```jsonc
{ "targets": { "on-call": { "connector": "matrix", "enabled": false, "...": "..." } } }
```

Its config is still validated, and any route pointing only at disabled targets is called out
at startup:

```
[WRN] route "blocked work" points only at disabled targets — it will deliver nothing
```

---

## When an event isn't arriving

Set `logLevel` to `debug` and the routing decisions become visible — which is usually where the
answer is.

```
[DBG] routed event=card.moved eventId=01J9ZQ... routes="card activity" targets=team-chat
[DBG] no route matched event=comment.created board=research
[DBG] duplicate delivery ignored event=card.moved eventId=01J9ZQ...
```

Read them in order:

- **`no route matched`** — the delivery arrived and verified, and no route wanted it. Check the
  event type against your `events` list, and the board slug against `boards`.
- **`duplicate delivery ignored`** — Collaboard re-delivered an event Collabcast already
  handled. Expected, and not a problem.
- **`rejected delivery: signature missing or invalid`** — the secret here and the secret on the
  subscription don't match. The subscription's secret is write-only and can't be read back;
  re-set it on both sides.
- **Nothing at all in the log** — the request never arrived. The URL is the first suspect
  (loopback can't work), then the port's reachability from the Collaboard host. Collaboard's own
  delivery log will show the attempts and why they failed:
  `GET /api/v1/webhooks/deliveries?subscriptionId={id}`.
- **`delivered`, but nothing in the destination** — for Matrix, the usual cause is an encrypted
  room: the message arrives but can't be decrypted by anyone. Use an unencrypted room.

One thing the log can't show you: an event Collaboard dropped before it ever attempted delivery.
Its queue is in memory, so an event pending when the Collaboard API restarts is gone, without
even a failed-attempt row on its side. Rare, and the card is still sitting on the board — but
it's why this is a notifier and not an audit log.
