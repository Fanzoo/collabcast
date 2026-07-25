#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { loadConfig, describeConfig } from "./config.mjs";
import { createReceiver } from "./receiver.mjs";
import { createDedupe } from "./dedupe.mjs";
import { normalize, summarize } from "./event.mjs";
import { route } from "./router.mjs";
import { deliver } from "./dispatch.mjs";
import { connectorIds } from "./connectors/index.mjs";
import { log, setLevel } from "./log.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

async function version() {
  try {
    const pkg = JSON.parse(await readFile(join(HERE, "..", "package.json"), "utf8"));
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function parseArgs(argv) {
  const options = { configPath: process.env.COLLABCAST_CONFIG ?? "config.json", check: false, help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--check") options.check = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--version" || arg === "-v") options.version = true;
    else if (arg === "--config" || arg === "-c") options.configPath = argv[++i];
    else if (arg.startsWith("--config=")) options.configPath = arg.slice("--config=".length);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.configPath) throw new Error("--config needs a path");
  return options;
}

function usage() {
  return `collabcast — a bridge between Collaboard board events and the systems you already use.

Usage:
  collabcast [--config <path>]     Start the receiver.
  collabcast --check               Validate the config and exit without listening.
  collabcast --version
  collabcast --help

Options:
  -c, --config <path>   Path to config.json (default: ./config.json,
                        or $COLLABCAST_CONFIG).

Connectors available: ${connectorIds().join(", ")}
`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    process.stdout.write(usage());
    return 0;
  }
  if (options.version) {
    process.stdout.write(`${await version()}\n`);
    return 0;
  }

  const configPath = resolve(options.configPath);
  const config = await loadConfig(configPath);
  setLevel(config.logLevel);

  const summaryLines = describeConfig(config);
  if (options.check) {
    process.stdout.write(`config ${configPath} is valid\n`);
    process.stdout.write(`  listen      ${summaryLines.listen}\n`);
    process.stdout.write(`  signature   ${summaryLines.signed ? "required" : "not verified"}\n`);
    process.stdout.write(`  deep links  ${summaryLines.deepLinks}\n`);
    for (const target of summaryLines.targets) process.stdout.write(`  target      ${target}\n`);
    for (const entry of summaryLines.routes) process.stdout.write(`  route       ${entry}\n`);
    for (const warning of config.warnings) process.stdout.write(`  warning     ${warning}\n`);
    return 0;
  }

  log.info(`collabcast ${await version()} starting`, { config: configPath });
  for (const warning of config.warnings) log.warn(warning);

  // ---- open targets ----
  const targets = new Map();
  for (const target of Object.values(config.targets)) {
    if (!target.enabled) {
      log.info("target disabled, skipping", { target: target.name, connector: target.connectorId });
      continue;
    }
    const instance = target.connector.open(target.options, {
      name: target.name,
      log: log.child({ target: target.name }),
    });
    targets.set(target.name, { ...target, instance });
    log.info("target ready", { target: target.name, connector: target.connectorId });
  }

  if (targets.size === 0) log.warn("no enabled targets — events will be received and then dropped");

  // Preflight is best-effort on purpose. Collabcast and the systems it talks to
  // often start at the same moment (a container runtime may still be booting), so a
  // destination being unreachable right now must not stop the receiver from coming
  // up — the retry loop in dispatch handles it once events start arriving.
  //
  // Run after the listener is bound, and don't block on it: an unreachable
  // destination costs a full connector timeout per target, and doing that first
  // would mean deliveries hitting a refused connection for as long as it takes.
  async function preflightTargets() {
    for (const [name, target] of targets) {
      if (typeof target.instance.preflight !== "function") continue;
      try {
        const detail = await target.instance.preflight();
        log.info("target preflight ok", { target: name, ...detail });
      } catch (error) {
        log.warn("target preflight failed — starting anyway", { target: name, error: error.message });
      }
    }
  }

  // ---- wire the pipeline ----
  const dedupe = createDedupe(config.dedupe.capacity);
  const inFlight = new Set();

  function onEvent(payload) {
    const event = normalize(payload);

    if (!event.type) {
      log.warn("ignoring delivery with no event type");
      return;
    }
    if (dedupe.check(event.id)) {
      log.debug("duplicate delivery ignored", { event: event.type, eventId: event.id });
      return;
    }

    const { targets: selected, routes: matched } = route(event, config.routes);
    if (selected.length === 0) {
      log.debug("no route matched", { event: event.type, board: event.board.slug });
      return;
    }

    const message = { event, summary: summarize(event, { baseUrl: config.collaboard.baseUrl }) };
    log.debug("routed", {
      event: event.type,
      eventId: event.id,
      routes: matched.map((r) => r.name).join(","),
      targets: selected.join(","),
    });

    for (const name of selected) {
      const target = targets.get(name);
      if (!target) continue; // disabled at startup
      const pending = deliver({
        target,
        message,
        attempts: config.delivery.attempts,
        backoffMs: config.delivery.backoffMs,
        log,
      })
        .catch((error) => log.error("dispatch crashed", { target: name, error: error.message }))
        .finally(() => inFlight.delete(pending));
      inFlight.add(pending);
    }
  }

  // ---- listen ----
  const server = createReceiver({ config, onEvent, log });

  await /** @type {Promise<void>} */ (
    new Promise((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(config.listen.port, config.listen.host, () => {
        server.removeListener("error", rejectListen);
        resolveListen();
      });
    })
  );

  // The listen guard above is removed once bound, and a `net.Server` 'error' with no
  // listener is thrown — an accept failure (EMFILE under load, say) would take the
  // process down instead of being logged.
  server.on("error", (error) => log.error("server error", { error: error.message }));

  log.info("listening", {
    url: `http://${config.listen.host}:${config.listen.port}${config.listen.path}`,
    signature: config.signing.secret ? "required" : "not verified",
  });

  preflightTargets().catch((error) => log.warn("preflight aborted", { error: error.message }));

  // ---- shutdown ----
  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    log.info("shutting down", { signal });

    await new Promise((done) => server.close(done));

    if (inFlight.size > 0) {
      log.info("waiting for in-flight deliveries", { count: inFlight.size });
      const grace = new Promise((done) => setTimeout(done, 10_000).unref());
      await Promise.race([Promise.allSettled([...inFlight]), grace]);
      if (inFlight.size > 0) log.warn("exiting with deliveries still pending", { count: inFlight.size });
    }

    log.info("stopped");
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  return null; // keep running
}

main()
  .then((code) => {
    if (typeof code === "number") process.exit(code);
  })
  .catch((error) => {
    log.error(error.message);
    process.exit(1);
  });
