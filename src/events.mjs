// The Collaboard event catalog, as published in the Collaboard API reference.
// Collabcast validates route selections against this list so a typo in config
// fails at startup rather than silently matching nothing.

export const EVENT_TYPES = [
  // Cards
  "card.created",
  "card.moved",
  "card.updated",
  "card.archived",
  "card.restored",
  "card.labeled",
  "card.unlabeled",
  // Comments
  "comment.created",
  "comment.updated",
  "comment.deleted",
  // Labels (the label resource on a board, not a card's label set)
  "label.created",
  "label.updated",
  "label.deleted",
  // Attachments (metadata only — file bytes never ride the wire)
  "attachment.created",
  "attachment.deleted",
  // Lanes
  "lane.created",
  "lane.renamed",
  "lane.reordered",
  "lane.deleted",
  // Boards
  "board.created",
  "board.renamed",
  "board.deleted",
];

/**
 * Test deliveries only. Board activity never produces a ping and a Collaboard
 * subscription cannot select it, but it does arrive at the receiver — so a route
 * may name it if you want test deliveries to reach a target.
 */
export const PING = "webhook.ping";

/**
 * The human-role allowlist. Collaboard's integration guide is explicit that this
 * must be an allowlist of human roles rather than a denylist of agent roles: the
 * agent side already has two roles and the set can grow, so a denylist springs a
 * leak the day a new agent role is added.
 */
export const HUMAN_ROLES = ["Administrator", "HumanUser"];

/** Every value a route's `when.events` may contain. */
export const SELECTABLE_EVENTS = new Set([...EVENT_TYPES, PING, "*"]);
