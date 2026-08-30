# The Matrix connector

Posts each routed event as a message into a Matrix room, over the client-server API.
There's no SDK involved — sending a message is one authenticated `PUT` — so this connector
is about 150 lines and adds nothing to install.

It works with any spec-compliant homeserver. The setup below uses plain `curl` against the
client-server API so it doesn't depend on which one you run.

---

## What you need

Three things, in this order: a **bot user**, an **access token** for it, and a **room** it
has joined.

Throughout, replace `https://matrix.example.org` with your homeserver's client API base
URL and `example.org` with your server name. They're often different — the server name is
the part after the colon in user and room ids.

### 1. Create a bot user

Give the bridge its own account rather than reusing yours. Its messages should be
attributable to the bridge, and a token you can revoke without logging yourself out of
everything.

If your homeserver has open registration or a registration token, register over the API.
Registration is an interactive-auth flow: the first request comes back `401` with a
session id, and you send that session id back with the credential.

```bash
# Step 1 — start the flow and read the session id out of the 401.
curl -s -X POST https://matrix.example.org/_matrix/client/v3/register \
  -H "Content-Type: application/json" \
  -d '{"username": "collabcast", "password": "<a-strong-password>"}'
```

```json
{
  "session": "abcdefghijklmnop",
  "flows": [{ "stages": ["m.login.registration_token", "m.login.dummy"] }],
  "errcode": "M_FORBIDDEN"
}
```

```bash
# Step 2 — satisfy the registration-token stage, carrying that session id.
curl -s -X POST https://matrix.example.org/_matrix/client/v3/register \
  -H "Content-Type: application/json" \
  -d '{
        "username": "collabcast",
        "password": "<a-strong-password>",
        "initial_device_display_name": "collabcast",
        "auth": {
          "type": "m.login.registration_token",
          "token": "<your-registration-token>",
          "session": "abcdefghijklmnop"
        }
      }'
```

Depending on the homeserver you may need one more call with
`"auth": {"type": "m.login.dummy", "session": "..."}` to finish the flow. The final
response carries a `user_id` and, usually, an `access_token` — if it does, that's the token
you need and you can skip the next step.

> If registration is closed and you'd rather not open it, create the user with your
> homeserver's own admin tooling instead — Synapse has `register_new_matrix_user`, Conduit
> and its forks accept a registration token, and most have an admin room or CLI. Any route
> that gets you a user works; Collabcast only ever sees the access token.

### 2. Get an access token

If registration didn't hand you one, log in:

```bash
curl -s -X POST https://matrix.example.org/_matrix/client/v3/login \
  -H "Content-Type: application/json" \
  -d '{
        "type": "m.login.password",
        "identifier": { "type": "m.id.user", "user": "collabcast" },
        "password": "<a-strong-password>",
        "initial_device_display_name": "collabcast"
      }'
```

```json
{
  "user_id": "@collabcast:example.org",
  "access_token": "syt_...",
  "device_id": "ABCDEFGHIJ"
}
```

Keep the `access_token`. It goes in the environment, never in the config file — see
[Keeping secrets out of the repo](../../README.md#keeping-secrets-out-of-the-repo).

> **Don't log this device out.** A Matrix access token belongs to a device, and logging
> that device out invalidates the token. If you ever do, log in again and update the
> environment variable. Deliveries will fail with a permanent `401` in the meantime, which
> the log will say plainly.

### 3. Create the room and get the bot into it

Create the room from your own client — a normal room, encryption **off** (see the caveat
below) — and note its address.

Then invite the bot from your account, and accept from the bot's:

```bash
# Accept the invite as the bot. Works with a room id or an alias.
curl -s -X POST \
  "https://matrix.example.org/_matrix/client/v3/join/%23collattice%3Aexample.org" \
  -H "Authorization: Bearer $MATRIX_ACCESS_TOKEN" \
  -H "Content-Type: application/json" -d '{}'
```

```json
{ "room_id": "!AbCdEfGhIjKlMnOpQr:example.org" }
```

Note the `#` in an alias must be percent-encoded as `%23` and the `:` as `%3A` in a URL.

> **Encrypted rooms are not supported.** Collabcast sends plaintext events over the
> client-server API; it does not implement Olm/Megolm. In an encrypted room the messages
> arrive but render as undecryptable for everyone. Use an unencrypted room — which is the
> right call anyway for a notification feed whose content is already on a board your team
> can read.

---

## Configure the target

```jsonc
// config.json
{
  "targets": {
    "team-chat": {
      "connector": "matrix",
      "homeserver": "https://matrix.example.org",
      "accessToken": "env:MATRIX_ACCESS_TOKEN",
      "room": "#collattice:example.org"
    }
  }
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `homeserver` | *(required)* | Client API base URL, `http` or `https`. If the homeserver runs on the same host, its loopback address is fine — this is Collabcast dialling out, so the inbound restriction in [Reaching the receiver](../../README.md#reaching-the-receiver) does not apply here. |
| `accessToken` | *(required)* | The bot's access token. Write it as `env:NAME`. |
| `room` | *(required)* | A room id (`!AbCdEf:example.org`) or an alias (`#collattice:example.org`). An alias is resolved once at startup and reused. |
| `msgtype` | `m.notice` | `m.notice` or `m.text`. |
| `timeoutMs` | `10000` | Per-request timeout against the homeserver. |
| `includeOccurredAt` | `false` | Append Collattice's `occurredAt` to each message. Off by default because your client already shows an arrival time; turn it on if you care about the difference (see [Ordering](#ordering) below). |

**Why `m.notice` is the default.** Notices render muted in most clients and are excluded
from other bots' trigger rules by convention — so a busy board doesn't shout, and a
notification feed can't accidentally drive another integration. Switch to `m.text` if you
want these to look like ordinary messages and count as normal activity.

### A room id or an alias?

Either works. An alias is easier to read and survives the room being recreated; a room id
skips one API call at startup and can't break if someone removes the alias. If you give an
alias, Collabcast resolves it once and logs the result:

```
2026-07-25T12:00:00.000Z [INF] resolved room alias target=team-chat alias=#collattice:example.org roomId=!AbCdEf:example.org
```

---

## What the messages look like

Each message is sent with both a plain-text `body` and an HTML `formatted_body`, so it
reads correctly in every client.

```
🆕 [research] created #321 Investigate flaky test in Inbox · Alex Rivera
➡️ [research] moved #321 Investigate flaky test from Doing to Ready · Alex Rivera
💬 [research] commented on #321 — “Looks good, shipping.” · Alex Rivera
📎 [website] attached screenshot.png to #88 (50.0 KB) · Scout (agent)
```

The board slug is in brackets, the actor is on the end, and an actor that isn't a human
role is marked `(agent)`. Every event family has a form — cards, comments, labels,
attachments, lanes, and boards — and an event type this version has never heard of still
renders, using its type name, so a `"*"` route won't produce blanks after a Collattice
upgrade.

Set `collattice.baseUrl` and the card reference becomes a link straight to the card:

```jsonc
{ "collattice": { "baseUrl": "https://board.example.org" } }
```

Card names are HTML-escaped on the way in, so a card titled `<img src=x onerror=...>`
shows up as text rather than becoming markup in anyone's client.

### Ordering

Collattice delivery is best-effort and not strictly ordered, so two events can arrive out
of the order they happened, and Collabcast posts on arrival rather than buffering to
reorder. In practice the skew is small and each message is self-contained. If you need to
see the real order, turn on `includeOccurredAt` — the authoritative server-side timestamp
then rides in every message.

---

## Confirming it works

Just after the receiver starts listening, the connector checks the token and resolves the
room:

```
2026-07-25T12:00:00.000Z [INF] target preflight ok target=team-chat user=@collabcast:example.org room=!AbCdEf:example.org
```

If that line says `target preflight failed` instead, Collabcast **still starts** — on
purpose. The bridge and its destinations often come up at the same moment, and a homeserver
that isn't ready yet shouldn't stop the receiver from accepting events. The retry loop
picks it up when traffic arrives.

Then send a test delivery from Collattice's **Admin → Webhooks** screen (or the
`test_webhook` MCP tool). A `webhook.ping` is delivery-only — board activity never produces
one and a subscription can't select it — so it reaches the receiver but only lands in chat
if a route names it:

```jsonc
{ "name": "pings", "when": { "events": ["webhook.ping"] }, "to": ["team-chat"] }
```

Without that route the ping still proves the useful half: that Collattice reached you and
the signature verified. Watch for it at `logLevel: "debug"`.

## When it breaks

Errors are logged with the homeserver's own error code, which is usually enough to name the
cause:

| Symptom | Cause |
|---------|-------|
| `401 M_UNKNOWN_TOKEN` | The access token is wrong, or its device was logged out. Marked permanent — not retried. |
| `403 M_FORBIDDEN` | The bot isn't in the room, or can't send to it. Check it accepted the invite, and that its power level clears the room's `events_default`. Marked permanent. |
| `404 M_NOT_FOUND` on an alias | The alias doesn't exist on that server. Check the spelling, including the part after the colon. |
| `429 M_LIMIT_EXCEEDED` | Rate limited. The homeserver's `retry_after_ms` is honoured rather than guessed at, up to a one-minute ceiling. |
| `cannot reach homeserver` | Connection refused, DNS failure, or timeout. Retried with backoff. |

Permanent errors are not retried, because retrying can't fix them — they're logged once at
`error` and the event is dropped. Everything else is retried up to `delivery.attempts`.
