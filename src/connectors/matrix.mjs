import { randomUUID } from "node:crypto";

/**
 * Matrix connector — posts each event as a message into a room, over the Matrix
 * client-server API. No SDK: sending a message is one authenticated PUT.
 */

export const id = "matrix";
export const label = "Matrix";

/**
 * The full option surface of a `matrix` target, after defaults are applied.
 *
 * @typedef {object} MatrixSettings
 * @property {string} homeserver Client API base URL, without a trailing slash.
 * @property {string} accessToken The bot's access token.
 * @property {string} room A room id (`!abc:example.org`) or alias (`#room:example.org`).
 * @property {"m.notice" | "m.text"} msgtype
 * @property {number} timeoutMs Per-request timeout against the homeserver.
 * @property {boolean} includeOccurredAt Append Collaboard's `occurredAt` to each message.
 */

const DEFAULTS = {
  msgtype: "m.notice",
  timeoutMs: 10_000,
  includeOccurredAt: false,
};

const ROOM_ID = /^![^:]+:.+$/;
const ROOM_ALIAS = /^#[^:]+:.+$/;

/**
 * @param {Record<string, any>} options
 * @param {Pick<import("../../types.js").ConnectorContext, "name">} ctx
 * @returns {void}
 */
export function validate(options, ctx) {
  const where = `targets.${ctx.name}`;
  /**
   * @param {string} message
   * @returns {never} always throws — which is what lets the checks below assume
   * everything above them succeeded.
   */
  const fail = (message) => {
    throw new Error(`${where}: ${message}`);
  };

  for (const key of ["homeserver", "accessToken", "room"]) {
    if (typeof options[key] !== "string" || options[key].trim() === "") {
      fail(`"${key}" is required and must be a non-empty string`);
    }
  }

  let url;
  try {
    url = new URL(options.homeserver);
  } catch {
    fail(`"homeserver" is not a valid URL: ${options.homeserver}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    fail(`"homeserver" must be http or https, got ${url.protocol}`);
  }

  if (!ROOM_ID.test(options.room) && !ROOM_ALIAS.test(options.room)) {
    fail(`"room" must be a room id ("!abc:example.org") or an alias ("#room:example.org"), got "${options.room}"`);
  }

  if (options.msgtype !== undefined && !["m.notice", "m.text"].includes(options.msgtype)) {
    fail(`"msgtype" must be "m.notice" or "m.text", got "${options.msgtype}"`);
  }

  if (options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 250)) {
    fail(`"timeoutMs" must be an integer of at least 250`);
  }
}

/**
 * @param {Record<string, any>} options
 * @param {import("../../types.js").ConnectorContext} ctx
 * @returns {import("../../types.js").ConnectorInstance}
 */
export function open(options, ctx) {
  // Built field by field rather than spread, so the options this connector
  // actually reads are visible in one place and a stray key can't ride along.
  /** @type {MatrixSettings} */
  const settings = {
    homeserver: options.homeserver,
    accessToken: options.accessToken,
    room: options.room,
    msgtype: options.msgtype ?? DEFAULTS.msgtype,
    timeoutMs: options.timeoutMs ?? DEFAULTS.timeoutMs,
    includeOccurredAt: options.includeOccurredAt ?? DEFAULTS.includeOccurredAt,
  };
  const base = settings.homeserver.replace(/\/+$/, "");
  const log = ctx.log;

  // An alias resolves to a room id once and is then reused; a room id is used as-is.
  /** @type {string | null} */
  let resolvedRoomId = ROOM_ID.test(settings.room) ? settings.room : null;

  /**
   * @param {string} method
   * @param {string} path
   * @param {{ body?: unknown, timeoutMs?: number }} [init]
   * @returns {Promise<Record<string, any>>}
   */
  async function call(method, path, { body, timeoutMs = settings.timeoutMs } = {}) {
    let response;
    try {
      response = await fetch(`${base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${settings.accessToken}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      // Connection refused, DNS failure, timeout — all worth retrying.
      const error = new Error(`cannot reach homeserver: ${cause.message}`);
      error.cause = cause;
      throw error;
    }

    const raw = await response.text();
    let payload = null;
    if (raw) {
      try {
        payload = JSON.parse(raw);
      } catch {
        // Not JSON — a reverse proxy error page, most likely. Keep the text.
      }
    }

    if (response.ok) return payload ?? {};

    const detail = payload?.error ?? (raw ? raw.slice(0, 200) : "no response body");
    const errcode = payload?.errcode ? ` ${payload.errcode}` : "";
    /** @type {import("../../types.js").DeliveryError} */
    const error = new Error(`homeserver responded ${response.status}${errcode}: ${detail}`);

    if (response.status === 429) {
      // Matrix tells us exactly how long to wait; honour it instead of guessing.
      error.retryAfterMs = Number.isFinite(payload?.retry_after_ms) ? payload.retry_after_ms : 5_000;
    }
    if (response.status === 401 || response.status === 403) {
      // A bad token or a room the bot cannot post to. Retrying cannot fix either.
      error.permanent = true;
    }
    throw error;
  }

  /** @returns {Promise<string>} */
  async function roomId() {
    if (resolvedRoomId) return resolvedRoomId;
    const payload = await call("GET", `/_matrix/client/v3/directory/room/${encodeURIComponent(settings.room)}`);
    if (!payload?.room_id) {
      throw new Error(`alias ${settings.room} did not resolve to a room id`);
    }
    const resolved = String(payload.room_id);
    resolvedRoomId = resolved;
    log.info("resolved room alias", { alias: settings.room, roomId: resolved });
    return resolved;
  }

  /**
   * A Matrix transaction id makes a send idempotent for a given access token, so
   * deriving it from the Collaboard event id gives a second line of defense
   * against duplicate deliveries — one that survives a Collabcast restart, which
   * the in-process dedupe set does not. The target name is folded in so two
   * targets pointing at different rooms don't collide.
   */
  function transactionId(event) {
    const seed = event.id ?? randomUUID();
    return `collabcast.${ctx.name}.${seed}`.replace(/[^A-Za-z0-9._-]/g, "-");
  }

  return {
    async preflight() {
      const who = await call("GET", "/_matrix/client/v3/account/whoami");
      const room = await roomId();
      return { user: who?.user_id ?? "unknown", room };
    },

    async send({ event, summary }) {
      const room = await roomId();
      const stamp = settings.includeOccurredAt && event.occurredAt ? ` (${event.occurredAt})` : "";

      await call(
        "PUT",
        `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/send/m.room.message/${encodeURIComponent(
          transactionId(event),
        )}`,
        {
          body: {
            msgtype: settings.msgtype,
            body: `${summary.icon} ${summary.text}${stamp}`,
            format: "org.matrix.custom.html",
            formatted_body: `${summary.icon} ${summary.html}${stamp}`,
          },
        },
      );
    },
  };
}
