/**
 * Collabcast's public type contract.
 *
 * Hand-written rather than generated: the sources stay plain `.mjs` that run
 * directly on Node with no build step, and this file is what gives editors and
 * `tsc --noEmit` something to check them against. It is also the contract a
 * connector author codes to — see docs/writing-a-connector.md.
 *
 * Reference these from JSDoc in a `.mjs` file like this:
 *
 *     /** @type {import("../types.js").Connector} *\/
 *
 * (`../types.js` resolves to this declaration file; there is no `types.js`.)
 */

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** The roles Collattice reports in an event's `actor`. */
export type ActorRole = "Administrator" | "HumanUser" | "AgentUser" | "AgentAdministrator";

/** The 22 Collattice event types, plus the test-delivery ping. */
export type KnownEventType =
  | "card.created"
  | "card.moved"
  | "card.updated"
  | "card.archived"
  | "card.restored"
  | "card.labeled"
  | "card.unlabeled"
  | "comment.created"
  | "comment.updated"
  | "comment.deleted"
  | "label.created"
  | "label.updated"
  | "label.deleted"
  | "attachment.created"
  | "attachment.deleted"
  | "lane.created"
  | "lane.renamed"
  | "lane.reordered"
  | "lane.deleted"
  | "board.created"
  | "board.renamed"
  | "board.deleted"
  | "webhook.ping";

/**
 * A known event type, or any other string.
 *
 * Deliberately open: Collattice may add event types this build has never heard
 * of, a `"*"` route will forward them, and a connector must be able to compare
 * against one without a cast. The union still drives autocomplete.
 */
export type EventType = KnownEventType | (string & {});

/** What a route may name in `when.events` — an event type or the wildcard. */
export type EventSelector = EventType | "*";

export interface Actor {
  /** Collattice user id (GUID), or null when the event carries no actor. */
  id: string | null;
  name: string | null;
  /**
   * The role name as Collattice sent it.
   *
   * Open on purpose — Collattice may add roles, and a closed union would turn a
   * perfectly real role into a compile error. The cost is that a *typo* in a
   * comparison (`"HumanUsr"`) is not caught either, which is one more reason to
   * branch on {@link Actor.isHuman} rather than on this string.
   */
  role: ActorRole | (string & {}) | null;
  /**
   * True only for `Administrator` and `HumanUser`.
   *
   * An allowlist of human roles, not a denylist of agent roles — the agent side
   * already has two roles and the set can grow, so a denylist would spring a
   * leak the day a new one is added. Prefer this over comparing `role` yourself.
   */
  isHuman: boolean;
}

export interface BoardRef {
  /** Board id (GUID). Null for a `webhook.ping`, which is not board-scoped. */
  id: string | null;
  /** Board slug — the human-readable key to route on. Null for a ping. */
  slug: string | null;
}

/** A Collattice delivery, normalized. What a connector receives. */
export interface CollabcastEvent {
  /**
   * Collattice's `eventId` (a ULID), stable across retries of the same event —
   * so it doubles as an idempotency key for a destination that accepts one.
   */
  id: string | null;
  type: EventType;
  /** Contract version, currently `"1"`. */
  version: string | null;
  /** ISO-8601 UTC. When the fact happened server-side — sort on this, not arrival. */
  occurredAt: string | null;
  board: BoardRef;
  actor: Actor;
  /**
   * The per-event payload, passed through exactly as Collattice sent it. Shapes
   * differ per event family; read it leniently and ignore what you don't know,
   * because fields may be added within a contract version.
   */
  data: Record<string, any>;
  /** The entire original body, for anything `data` doesn't cover. */
  raw: Record<string, any>;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * A connector-neutral rendering of one event, so a connector doesn't have to
 * think about formatting. `text` and `html` always describe the same thing.
 */
export interface Summary {
  /** A single emoji for the event family. */
  icon: string;
  /** `[research] moved #321 Investigate flaky test from Doing to Ready · Alex Rivera` */
  text: string;
  /** The same line with `<b>`, `<i>`, and — when `collattice.baseUrl` is set — `<a>`. */
  html: string;
}

/** What `send` is handed: the event, and its rendered summary. */
export interface Message {
  event: CollabcastEvent;
  summary: Summary;
}

// ---------------------------------------------------------------------------
// Connectors
// ---------------------------------------------------------------------------

/**
 * An error thrown from `send`, optionally shaping how the retry loop responds.
 * A plain `Error` means "transient, retry with the computed backoff".
 */
export interface DeliveryError extends Error {
  /**
   * Wait exactly this long before the next attempt instead of the computed
   * backoff. Set it whenever the destination told you how long to wait.
   */
  retryAfterMs?: number;
  /**
   * Don't retry at all. For anything an operator has to fix — a rejected
   * credential, a destination refusing this account, a malformed request —
   * because retrying can't fix it and would bury the real cause.
   */
  permanent?: boolean;
}

export interface Logger {
  error(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  debug(message: string, fields?: Record<string, unknown>): void;
  /** A logger that stamps every line with the same fields. */
  child(fields: Record<string, unknown>): Logger;
}

export interface ConnectorContext {
  /** The target's configured name — the key under `targets` in config.json. */
  name: string;
  /** A logger already stamped with this target's name. */
  log: Logger;
}

export interface ConnectorInstance {
  /**
   * Optional, and best-effort: verify credentials and return anything worth
   * logging. If it throws, Collabcast logs a warning and starts anyway, because
   * a destination that isn't ready yet must not stop the receiver from accepting
   * events. Nothing load-bearing belongs here.
   */
  preflight?(): Promise<Record<string, unknown> | void>;
  /** Deliver one event. Return normally on success; throw to ask for a retry. */
  send(message: Message): Promise<void>;
  /** Optional cleanup on shutdown. */
  close?(): Promise<void> | void;
}

/**
 * A connector: a module that knows how to deliver an event to one outside
 * system. Register it in `src/connectors/index.mjs`.
 */
export interface Connector {
  /** The value operators write as `"connector": "..."` in a target. */
  id: string;
  /** A human-readable name, for logs and docs. */
  label: string;
  /**
   * Throw an `Error` if these options can't work. Called at startup, before the
   * listener opens. Prefix messages with `targets.${ctx.name}:`.
   */
  validate(options: any, ctx: Pick<ConnectorContext, "name">): void;
  /** Build the live instance. Called once per enabled target at startup. */
  open(options: any, ctx: ConnectorContext): ConnectorInstance;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export type LogLevel = "error" | "warn" | "info" | "debug";

/**
 * A route's match conditions. All are ANDed; an empty array or `false` means
 * "no restriction on this axis".
 */
export interface RouteConditions {
  events: EventSelector[];
  /** Board slugs. A `webhook.ping` is exempt — it is not board-scoped. */
  boards: string[];
  /** Lane names a card must have come to rest in. */
  enterLanes: string[];
  humanActorsOnly: boolean;
}

export interface Route {
  name: string;
  /** Target names, as keyed under `targets`. */
  to: string[];
  when: RouteConditions;
}

/** A target after validation, with its connector module resolved. */
export interface ResolvedTarget {
  name: string;
  connectorId: string;
  connector: Connector;
  enabled: boolean;
  /** The target's config minus `connector` and `enabled`, `env:` refs resolved. */
  options: Record<string, any>;
}

/** A resolved target with its opened instance attached. */
export interface LiveTarget extends ResolvedTarget {
  instance: ConnectorInstance;
}

/** The validated configuration. */
export interface Config {
  logLevel: LogLevel;
  collattice: { baseUrl: string | null };
  listen: { host: string; port: number; path: string; maxBodyBytes: number };
  signing: { secret: string | null };
  delivery: { attempts: number; backoffMs: number };
  dedupe: { capacity: number };
  targets: Record<string, ResolvedTarget>;
  routes: Route[];
  /** Non-fatal problems worth logging at startup. */
  warnings: string[];
}
