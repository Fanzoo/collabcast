import { readFile } from "node:fs/promises";
import { SELECTABLE_EVENTS } from "./events.mjs";
import { connectorIds, getConnector } from "./connectors/index.mjs";
import { levelNames } from "./log.mjs";

const DEFAULTS = {
  logLevel: "info",
  listen: { host: "0.0.0.0", port: 9080, path: "/collabcast", maxBodyBytes: 1_048_576 },
  delivery: { attempts: 4, backoffMs: 1_000 },
  dedupe: { capacity: 2048 },
};

const ENV_REF = /^env:([A-Za-z_][A-Za-z0-9_]*)$/;

/**
 * Replace every `"env:NAME"` string anywhere in the config with the value of that
 * environment variable, failing loud when it is unset.
 *
 * This is what keeps a real config out of a public repository: the file names the
 * variable, the process supplies the value, and nothing secret is ever written to
 * disk in the repo.
 */
function resolveEnvRefs(node, trail = []) {
  if (typeof node === "string") {
    const match = ENV_REF.exec(node);
    if (!match) return node;
    const name = match[1];
    const value = process.env[name];
    if (value === undefined || value === "") {
      throw new Error(
        `${trail.join(".") || "config"} is "env:${name}", but the environment variable ${name} is not set`,
      );
    }
    return value;
  }
  if (Array.isArray(node)) return node.map((item, index) => resolveEnvRefs(item, [...trail, index]));
  if (node && typeof node === "object") {
    return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, resolveEnvRefs(value, [...trail, key])]));
  }
  return node;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>} narrowing the untrusted parsed JSON, so
 * everything after a guard can read keys off it without a cast.
 */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} raw
 * @returns {import("../types.js").Config}
 */
function validate(raw) {
  /** @type {string[]} */
  const problems = [];
  const fail = (message) => problems.push(message);

  if (!isPlainObject(raw)) throw new Error("config must be a JSON object");

  // A section written as something other than an object — `"listen": "0.0.0.0:9080"`,
  // a plausible typo — spreads to nothing, so without this it would pass every check
  // below and the process would quietly run on the defaults the operator overrode.
  for (const key of ["collaboard", "listen", "signing", "delivery", "dedupe"]) {
    if (raw[key] !== undefined && !isPlainObject(raw[key])) fail(`${key} must be an object`);
  }
  const section = (key) => (isPlainObject(raw[key]) ? raw[key] : {});

  /** @type {import("../types.js").Config} */
  const config = {
    logLevel: raw.logLevel ?? DEFAULTS.logLevel,
    collaboard: { baseUrl: null },
    listen: { ...DEFAULTS.listen, ...section("listen") },
    signing: { secret: section("signing").secret ?? null },
    delivery: { ...DEFAULTS.delivery, ...section("delivery") },
    dedupe: { ...DEFAULTS.dedupe, ...section("dedupe") },
    targets: {},
    routes: [],
    warnings: [],
  };

  if (!levelNames().includes(config.logLevel)) {
    fail(`logLevel must be one of ${levelNames().join(", ")} — got "${config.logLevel}"`);
  }

  // collaboard.baseUrl is optional; it only enables deep links back to the board.
  const baseUrl = section("collaboard").baseUrl ?? null;
  if (baseUrl !== null) {
    if (typeof baseUrl !== "string") fail("collaboard.baseUrl must be a string");
    else {
      try {
        new URL(baseUrl);
        config.collaboard.baseUrl = baseUrl.replace(/\/+$/, "");
      } catch {
        fail(`collaboard.baseUrl is not a valid URL: ${baseUrl}`);
      }
    }
  }

  const { listen } = config;
  if (typeof listen.host !== "string" || listen.host === "") fail("listen.host must be a non-empty string");
  if (!Number.isInteger(listen.port) || listen.port < 1 || listen.port > 65535) {
    fail(`listen.port must be an integer between 1 and 65535 — got ${listen.port}`);
  }
  if (typeof listen.path !== "string" || !listen.path.startsWith("/")) {
    fail(`listen.path must be a string beginning with "/" — got ${JSON.stringify(listen.path)}`);
  }
  if (!Number.isInteger(listen.maxBodyBytes) || listen.maxBodyBytes < 1024) {
    fail("listen.maxBodyBytes must be an integer of at least 1024");
  }

  if (config.signing.secret !== null && typeof config.signing.secret !== "string") {
    fail("signing.secret must be a string (or omitted to accept unsigned deliveries)");
  }
  if (typeof config.signing.secret === "string" && config.signing.secret.length < 16) {
    fail("signing.secret must be at least 16 characters — generate one with `openssl rand -hex 32`");
  }

  if (!Number.isInteger(config.delivery.attempts) || config.delivery.attempts < 1) {
    fail("delivery.attempts must be an integer of at least 1");
  }
  if (!Number.isInteger(config.delivery.backoffMs) || config.delivery.backoffMs < 0) {
    fail("delivery.backoffMs must be a non-negative integer");
  }
  if (!Number.isInteger(config.dedupe.capacity) || config.dedupe.capacity < 1) {
    fail("dedupe.capacity must be an integer of at least 1");
  }

  // ---- targets ----
  if (!isPlainObject(raw.targets) || Object.keys(raw.targets).length === 0) {
    fail("targets must be a non-empty object mapping a target name to its settings");
  } else {
    for (const [name, spec] of Object.entries(raw.targets)) {
      if (!isPlainObject(spec)) {
        fail(`targets.${name} must be an object`);
        continue;
      }
      const connector = getConnector(spec.connector);
      if (!connector) {
        fail(
          `targets.${name}.connector is ${JSON.stringify(spec.connector ?? null)} — known connectors: ${connectorIds().join(", ")}`,
        );
        continue;
      }
      const { connector: _ignored, enabled = true, ...options } = spec;
      if (typeof enabled !== "boolean") fail(`targets.${name}.enabled must be a boolean`);
      try {
        connector.validate(options, { name });
      } catch (error) {
        fail(error.message);
        continue;
      }
      config.targets[name] = { name, connectorId: spec.connector, connector, enabled, options };
    }
  }

  // ---- routes ----
  if (!Array.isArray(raw.routes) || raw.routes.length === 0) {
    fail("routes must be a non-empty array");
  } else {
    raw.routes.forEach((entry, index) => {
      const where = `routes[${index}]`;
      if (!isPlainObject(entry)) {
        fail(`${where} must be an object`);
        return;
      }

      const to = entry.to === undefined ? [] : Array.isArray(entry.to) ? entry.to : [entry.to];
      if (to.length === 0) fail(`${where}.to must name at least one target`);
      for (const target of to) {
        if (typeof target !== "string") fail(`${where}.to entries must be target names (strings)`);
        else if (!Object.hasOwn(raw.targets ?? {}, target)) {
          fail(`${where}.to names "${target}", which is not defined in targets`);
        }
      }

      const when = entry.when ?? {};
      if (!isPlainObject(when)) {
        fail(`${where}.when must be an object`);
        return;
      }

      const events = when.events === undefined ? [] : Array.isArray(when.events) ? when.events : [when.events];
      for (const type of events) {
        if (!SELECTABLE_EVENTS.has(type)) {
          fail(`${where}.when.events contains unknown event type "${type}"`);
        }
      }

      for (const key of ["boards", "enterLanes"]) {
        if (when[key] === undefined) continue;
        if (!Array.isArray(when[key]) || when[key].some((v) => typeof v !== "string")) {
          fail(`${where}.when.${key} must be an array of strings`);
        }
      }
      if (when.humanActorsOnly !== undefined && typeof when.humanActorsOnly !== "boolean") {
        fail(`${where}.when.humanActorsOnly must be a boolean`);
      }

      config.routes.push({
        name: entry.name ?? `route ${index + 1}`,
        to,
        when: {
          events,
          boards: when.boards ?? [],
          enterLanes: when.enterLanes ?? [],
          humanActorsOnly: when.humanActorsOnly ?? false,
        },
      });
    });
  }

  if (problems.length > 0) {
    throw new Error(`invalid configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  }

  // A route pointing only at disabled targets delivers nothing; that is legal but
  // worth surfacing, so record it for the caller to log.
  if (config.signing.secret === null) {
    config.warnings.push(
      "no signing.secret configured — deliveries are accepted without signature verification. " +
        "Set a secret here and on the Collaboard subscription.",
    );
  }
  for (const route of config.routes) {
    const live = route.to.filter((name) => config.targets[name]?.enabled);
    if (live.length === 0) {
      config.warnings.push(`route "${route.name}" points only at disabled targets — it will deliver nothing`);
    }
  }

  return config;
}

export async function loadConfig(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`cannot read config at ${path}: ${error.code ?? error.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`config at ${path} is not valid JSON: ${error.message}`);
  }

  return validate(resolveEnvRefs(parsed));
}

/** Config for logging and `--check` output, with anything secret removed. */
export function describeConfig(config) {
  return {
    listen: `${config.listen.host}:${config.listen.port}${config.listen.path}`,
    signed: config.signing.secret !== null,
    deepLinks: config.collaboard.baseUrl ?? "(disabled)",
    targets: Object.values(config.targets).map(
      (t) => `${t.name} (${t.connectorId}${t.enabled ? "" : ", disabled"})`,
    ),
    routes: config.routes.map((r) => {
      const when = r.when.events.length ? r.when.events.join(",") : "*";
      const filters = [
        r.when.boards.length ? `boards=${r.when.boards.join("|")}` : null,
        r.when.enterLanes.length ? `enterLanes=${r.when.enterLanes.join("|")}` : null,
        r.when.humanActorsOnly ? "humanActorsOnly" : null,
      ].filter(Boolean);
      return `${r.name}: ${when}${filters.length ? ` [${filters.join(" ")}]` : ""} → ${r.to.join(", ")}`;
    }),
  };
}

export { validate as validateConfig, resolveEnvRefs };
