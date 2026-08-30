# Deployment

Collabcast is a long-lived foreground process. It logs to stdout and stderr, reloads nothing
on its own, and exits cleanly on `SIGTERM` — closing the listener, waiting up to ten seconds
for in-flight deliveries, then stopping. Any supervisor can run it.

Two things to settle before you pick one: **which address Collattice will dial**, and **where
the secrets live**.

---

## Before you start: the URL

Collattice permanently refuses to deliver to loopback, so `http://localhost:9080` cannot be
your webhook URL — not even when Collabcast runs on the same machine as Collattice, which is
the normal case. See
[Reaching the receiver](../README.md#reaching-the-receiver) for the full picture and the
table of what to use instead. The short version: address the host by its tailnet name, its
LAN name, or its public name — anything but loopback.

Bind to `0.0.0.0` (the default) so the receiver accepts the connection on whichever
interface Collattice arrives on.

## Before you start: the secrets

Collabcast reads every `"env:NAME"` value in its config from the environment, so a working
`config.json` holds no secrets and can live in a repo. That pushes the question to the
supervisor: how does the process get the environment?

Put them in a file only the service account can read, and have the supervisor load it.
Where that file goes depends on the supervisor, because the two read it as different
users — the systemd unit below runs as `collabcast` with `ProtectHome=true`, so a copy
in your home directory would be unreadable to it.

**systemd** — a system-wide path the service user can read:

```bash
sudo install -m 700 -o collabcast -g collabcast -d /etc/collabcast
sudo install -m 600 -o collabcast -g collabcast /dev/null /etc/collabcast/env
sudo tee /etc/collabcast/env >/dev/null <<'EOF'
COLLABCAST_SIGNING_SECRET=<openssl rand -hex 32>
MATRIX_ACCESS_TOKEN=<the bot's access token>
EOF
```

**launchd** — your own home directory, since the agent runs as you:

```bash
install -m 700 -d ~/.collabcast
cat > ~/.collabcast/env <<'EOF'
COLLABCAST_SIGNING_SECRET=<openssl rand -hex 32>
MATRIX_ACCESS_TOKEN=<the bot's access token>
EOF
chmod 600 ~/.collabcast/env
```

Either way, don't put secrets on the command line — anyone who can run `ps` can read those.

---

## systemd (Linux)

```ini
# /etc/systemd/system/collabcast.service
[Unit]
Description=Collabcast — Collattice event bridge
# Ordering only; Collabcast starts fine whether or not these are up.
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=collabcast
WorkingDirectory=/opt/collabcast
ExecStart=/usr/bin/node /opt/collabcast/src/index.mjs --config /etc/collabcast/config.json
EnvironmentFile=/etc/collabcast/env
Restart=always
RestartSec=5s
# The log is the whole observability story — let the journal keep it.
StandardOutput=journal
StandardError=journal

# It needs to accept HTTP and make HTTP calls. Nothing else.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadOnlyPaths=/opt/collabcast

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now collabcast
journalctl -u collabcast -f
```

`EnvironmentFile` is the `/etc/collabcast/env` written above. It wants plain `KEY=value`
lines with no `export` and no quotes, and it must exist — systemd fails the unit on a
missing one unless the path is prefixed with `-`.

## launchd (macOS)

macOS has two kinds of service, and the difference matters more than it first appears.

- A **LaunchAgent** (`~/Library/LaunchAgents/`) runs in your user session. It starts when you
  log in and stops when you log out.
- A **LaunchDaemon** (`/Library/LaunchDaemons/`) runs at boot, as root or a named user, with
  no login required.

```xml
<!-- ~/Library/LaunchAgents/com.collabcast.bridge.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.collabcast.bridge</string>

  <!-- launchd does not expand ~ or read your shell profile. Absolute paths only. -->
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/you/collabcast/src/index.mjs</string>
    <string>--config</string>
    <string>/Users/you/.collabcast/config.json</string>
  </array>

  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <!-- Don't respawn faster than this if it crash-loops. -->
  <key>ThrottleInterval</key>
  <integer>10</integer>

  <key>StandardOutPath</key>
  <string>/Users/you/.collabcast/logs/collabcast.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/you/.collabcast/logs/collabcast.err.log</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>COLLABCAST_SIGNING_SECRET</key>
    <string>...</string>
    <key>MATRIX_ACCESS_TOKEN</key>
    <string>...</string>
  </dict>
</dict>
</plist>
```

```bash
mkdir -p ~/.collabcast/logs
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.collabcast.bridge.plist
launchctl print gui/$(id -u)/com.collabcast.bridge   # state, pid, exit history
tail -f ~/.collabcast/logs/collabcast.log

# after editing the plist
launchctl bootout gui/$(id -u)/com.collabcast.bridge
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.collabcast.bridge.plist
```

Two things about the plist above:

**`EnvironmentVariables` puts secrets in the plist.** That file is readable by your user, and
it's easy to back up or sync somewhere you didn't intend. If you'd rather keep them in a
`chmod 600` file, point `ProgramArguments` at a tiny wrapper that sources it and `exec`s
node — launchd itself has no equivalent of systemd's `EnvironmentFile`.

```bash
#!/bin/sh
# /Users/you/.collabcast/run.sh   (chmod 700)
set -a; . /Users/you/.collabcast/env; set +a
exec /usr/local/bin/node /Users/you/collabcast/src/index.mjs \
  --config /Users/you/.collabcast/config.json
```

**launchd does not rotate logs.** `StandardOutPath` grows forever. At `logLevel: "info"`
that's a line or two per event and will take years to matter, but if you run at `debug`, add
a `newsyslog.d` entry or point the paths at something that rotates.

### Will it survive a reboot?

A LaunchAgent starts at **login**, not at boot. If the Mac is a headless server that reboots
unattended, that distinction decides whether the bridge comes back.

Reaching for a LaunchDaemon is the usual fix — but **if FileVault is enabled it doesn't
help.** With FileVault on, the volume holding your binaries and config is encrypted and
unreadable until someone authenticates at the pre-boot screen; a LaunchDaemon is gated behind
that same unlock. Agent-versus-daemon isn't the lever. FileVault is.

So, on a Mac with FileVault:

- **Accept a manual unlock after a reboot.** Once you authenticate, macOS passes that through
  to log you in, and every LaunchAgent starts — Collabcast along with whatever else you run
  this way. Simple, and consistent with how Collattice itself is usually set up.
- **For planned reboots, use `sudo fdesetup authrestart`.** It stashes the unlock key in
  memory for exactly one reboot, so the machine comes back with no console access — the right
  tool for a remote OS update. It does nothing for an unexpected power loss.
- **For genuinely unattended reboots**, FileVault has to be off (macOS refuses auto-login while
  it's on). That's a real trade on a machine holding your boards and chat history; worth
  deciding on its own merits, not for a notification bridge.

Check what you actually have before assuming:

```bash
fdesetup status                # is FileVault on?
fdesetup supportsauthrestart   # is authrestart available?
```

---

## Start order doesn't matter

Collabcast comes up whether or not its destinations are reachable. Each connector's preflight
runs after the listener is bound and doesn't block it, so the receiver is answering — and
`/healthz` is green — before the first destination has been contacted. Preflight is
best-effort besides: a failure logs a warning and startup continues, because the bridge and
the systems it talks to are often starting at the same moment — a homeserver behind a
container runtime can easily be a minute behind. Once traffic arrives, `dispatch` retries
with backoff.

The same goes for Collattice. Collabcast is a passive listener, so Collattice starting later
is a non-event; the first delivery simply arrives whenever it arrives. No `After=` ordering,
no startup sleep, no dependency declaration is required for correctness — the `After=` line in
the systemd unit above is tidiness, not a requirement.

## Verifying a deployment

```bash
# 1. The process is up and answering.
curl -s http://localhost:9080/healthz     # -> ok
```

`/healthz` needs no signature. It's fine to hit over loopback — that restriction is on
Collattice's *outbound* deliveries, not on you.

```bash
# 2. The config is what you think it is.
node src/index.mjs --check --config /path/to/config.json
```

3. Send a test delivery from Collattice's **Admin → Webhooks** screen. A success there proves
   the URL is reachable and the signature matches. Watch the log:

```
2026-07-25T12:00:00.000Z [INF] listening url=http://0.0.0.0:9080/collabcast signature=required
2026-07-25T12:00:04.100Z [INF] delivered target=team-chat event=card.moved eventId=01J9ZQK...
```

4. Move a card on a **scratch board** to see a real event end to end. A subscription fires for
   every matching event on every board it selects, so exercising the wiring on a live board
   triggers your real routes against real cards.

If a delivery isn't arriving, the two places to look are Collabcast's log at
`logLevel: "debug"` — which logs routing decisions, dropped duplicates, and events no route
matched — and Collattice's own delivery log, which records every attempt with its status code
and error:

```
GET /api/v1/webhooks/deliveries?subscriptionId={id}
```

A run of `Failed` rows there with no corresponding line in Collabcast's log means the request
never arrived: check the URL isn't loopback, and that the port is reachable from the
Collattice host.
