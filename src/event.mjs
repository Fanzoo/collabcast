import { HUMAN_ROLES, PING } from "./events.mjs";

/**
 * Turn a raw Collattice delivery body into the shape the rest of Collabcast works
 * with. Deliberately lenient: it reads the fields it needs and ignores the rest,
 * because the contract says new fields may be added within `version: "1"` and a
 * strict reader would break the first time Collattice adds one.
 *
 * `data` is passed through untouched so a connector can reach anything the
 * normalizer does not lift out.
 *
 * @param {any} raw the parsed delivery body — untrusted, so every field is optional
 * @returns {import("../types.js").CollabcastEvent}
 */
export function normalize(raw) {
  const actor = raw?.actor ?? {};
  const role = actor.role ?? null;
  return {
    id: raw?.eventId ?? null,
    type: raw?.event ?? null,
    version: raw?.version ?? null,
    occurredAt: raw?.occurredAt ?? null,
    board: {
      // A ping is not board-scoped and carries an empty boardId/boardSlug.
      id: raw?.boardId || null,
      slug: raw?.boardSlug || null,
    },
    actor: {
      id: actor.userId ?? null,
      name: actor.name ?? null,
      role,
      isHuman: role != null && HUMAN_ROLES.includes(role),
    },
    data: raw?.data ?? {},
    raw,
  };
}

// Null-prototype: the key is `event.type`, straight off an untrusted delivery body.
// On a plain object literal, `"constructor"` or `"toString"` would resolve through
// the prototype chain to a function — non-nullish, so the `??` fallback below would
// not catch it, and the function would be rendered into the message.
const ICONS = Object.assign(Object.create(null), {
  "card.created": "🆕",
  "card.moved": "➡️",
  "card.updated": "✏️",
  "card.archived": "📦",
  "card.restored": "♻️",
  "card.labeled": "🏷️",
  "card.unlabeled": "🏷️",
  "comment.created": "💬",
  "comment.updated": "💬",
  "comment.deleted": "🗑️",
  "label.created": "🏷️",
  "label.updated": "🏷️",
  "label.deleted": "🗑️",
  "attachment.created": "📎",
  "attachment.deleted": "🗑️",
  "lane.created": "➕",
  "lane.renamed": "✏️",
  "lane.reordered": "🔀",
  "lane.deleted": "🗑️",
  "board.created": "🗂️",
  "board.renamed": "✏️",
  "board.deleted": "🗑️",
  [PING]: "📡",
});

/** Exported so a connector can escape anything it appends to `summary.html`. */
export const escapeHtml = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** Mark a token as a value worth emphasizing in rich output. */
const em = (value) => ({ value: String(value ?? "") });

/**
 * Build the plain and rich forms of one line from the same token list, so the two
 * can never drift apart. A token is a bare string (identical in both forms), or an
 * object carrying a value to emphasize and optionally a link to hang on it.
 */
function line(...tokens) {
  let text = "";
  let html = "";
  for (const token of tokens) {
    if (token === null || token === undefined || token === false) continue;
    if (typeof token === "string") {
      text += token;
      html += escapeHtml(token);
      continue;
    }
    text += token.value;
    html += token.href
      ? `<a href="${escapeHtml(token.href)}">${escapeHtml(token.value)}</a>`
      : `<b>${escapeHtml(token.value)}</b>`;
  }
  return { text: collapse(text), html: collapse(html) };
}

const collapse = (value) => value.replace(/[ \t]+/g, " ").trim();

/** `#321 Investigate flaky test`, or just `#321` when only a thin card ref rode along. */
function cardRef(card) {
  if (!card) return "a card";
  const parts = [];
  if (card.number !== undefined && card.number !== null) parts.push(`#${card.number}`);
  if (card.name) parts.push(String(card.name));
  return parts.join(" ") || "a card";
}

/**
 * A Collattice deep link to the card, when the operator told us the board's base
 * URL. Card numbers are scoped per board, so both the slug and the number are
 * required to build one.
 */
function cardUrl(card, event, baseUrl) {
  if (!baseUrl || !event.board?.slug) return null;
  if (card?.number === undefined || card?.number === null) return null;
  return `${baseUrl}/boards/${encodeURIComponent(event.board.slug)}/cards/${encodeURIComponent(card.number)}`;
}

function cardToken(card, event, baseUrl) {
  const href = cardUrl(card, event, baseUrl);
  const label = cardRef(card);
  return href ? { value: label, href } : em(label);
}

function excerpt(markdown, limit = 120) {
  if (!markdown) return null;
  const flat = String(markdown).replace(/\s+/g, " ").trim();
  if (!flat) return null;
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

function fileSize(bytes) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function describe(event, baseUrl) {
  const data = event.data ?? {};
  const card = data.card ?? null;
  const ref = () => cardToken(card, event, baseUrl);

  switch (event.type) {
    case "card.created":
      return line("created ", ref(), data.laneName ? " in " : "", data.laneName && em(data.laneName));
    case "card.moved":
      return line(
        "moved ",
        ref(),
        " from ",
        em(data.from?.laneName ?? "somewhere"),
        " to ",
        em(data.to?.laneName ?? data.laneName ?? "somewhere"),
      );
    case "card.updated":
      return line("updated ", ref());
    case "card.archived":
      return line("archived ", ref());
    case "card.restored":
      return line("restored ", ref(), data.laneName ? " to " : "", data.laneName && em(data.laneName));
    case "card.labeled":
      return line("added label ", em(data.label?.name ?? "a label"), " to ", ref());
    case "card.unlabeled":
      return line("removed label ", em(data.label?.name ?? "a label"), " from ", ref());

    case "comment.created": {
      const quote = excerpt(data.comment?.contentMarkdown);
      return line("commented on ", ref(), quote ? ` — “${quote}”` : "");
    }
    case "comment.updated":
      return line("edited a comment on ", ref());
    case "comment.deleted":
      return line("deleted a comment on ", ref());

    case "label.created":
      return line("created label ", em(data.label?.name ?? "a label"));
    case "label.updated":
      return line("updated label ", em(data.label?.name ?? "a label"));
    case "label.deleted":
      return line("deleted label ", em(data.label?.name ?? "a label"));

    case "attachment.created": {
      const size = fileSize(data.attachment?.sizeBytes);
      return line(
        "attached ",
        em(data.attachment?.fileName ?? "a file"),
        " to ",
        ref(),
        size ? ` (${size})` : "",
      );
    }
    case "attachment.deleted":
      return line("removed attachment ", em(data.attachment?.fileName ?? "a file"), " from ", ref());

    case "lane.created":
      return line("created lane ", em(data.lane?.name ?? "a lane"));
    case "lane.renamed":
      // The payload carries the lane's state at occurrence; the previous name is not in it.
      return line("renamed a lane to ", em(data.lane?.name ?? "a lane"));
    case "lane.deleted":
      return line("deleted lane ", em(data.lane?.name ?? "a lane"));
    case "lane.reordered": {
      const order = (data.lanes ?? []).map((lane) => lane?.name).filter(Boolean).join(" → ");
      return line("reordered lanes", order ? ": " : "", order && em(order));
    }

    case "board.created":
      return line("created board ", em(data.board?.name ?? "a board"));
    case "board.renamed":
      return line("renamed board to ", em(data.board?.name ?? "a board"));
    case "board.deleted":
      return line("deleted board ", em(data.board?.name ?? "a board"));

    case PING:
      return line("ping", data.message ? ` — ${data.message}` : "");

    default:
      // An event type added by a future Collattice version, matched by a "*" route.
      return line(String(event.type ?? "unknown event"));
  }
}

function actorLabel(actor) {
  if (!actor?.name) return null;
  return actor.isHuman ? actor.name : `${actor.name} (agent)`;
}

function boardUrl(event, baseUrl) {
  if (!baseUrl || !event.board?.slug) return null;
  return `${baseUrl}/boards/${encodeURIComponent(event.board.slug)}`;
}

/**
 * Render a connector-neutral summary of an event: an icon, a plain-text line, and
 * the same line with light HTML emphasis and links. A connector uses whichever
 * forms its destination understands, and reaches into `event` directly when it
 * wants more than the summary carries.
 *
 * @param {import("../types.js").CollabcastEvent} event
 * @param {{ baseUrl?: string | null }} [options]
 * @returns {import("../types.js").Summary}
 */
export function summarize(event, { baseUrl = null } = {}) {
  const body = describe(event, baseUrl);
  const slug = event.board?.slug;
  const actor = actorLabel(event.actor);
  const board = boardUrl(event, baseUrl);

  const prefixText = slug ? `[${slug}] ` : "";
  const prefixHtml = slug
    ? `[${board ? `<a href="${escapeHtml(board)}">${escapeHtml(slug)}</a>` : `<b>${escapeHtml(slug)}</b>`}] `
    : "";
  const suffixText = actor ? ` · ${actor}` : "";
  const suffixHtml = actor ? ` · <i>${escapeHtml(actor)}</i>` : "";

  return {
    icon: ICONS[event.type] ?? "•",
    text: `${prefixText}${body.text}${suffixText}`,
    html: `${prefixHtml}${body.html}${suffixHtml}`,
  };
}
