import { createServer } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";

// Collattice v3 renamed the delivery headers from `X-Collattice-*` to `X-Collattice-*`
// as part of the Collattice → Collattice rename. Both spellings are read, current first.
//
// Reading only the old names is exactly how this broke on the v2 → v3 upgrade, and the
// failure is worth remembering: an unrecognised signature header arrives as `undefined`,
// `verifySignature` refuses it on the type check, and EVERY delivery is answered 401. The
// sender records three failed attempts and drops the event permanently, so the symptom is
// silence — no messages, no errors on the receiving side that anyone is watching, and a
// failure count on the sender that nobody thinks to look at.
//
// Accepting both is not just repair. A fleet does not upgrade every board on the same day,
// and one bridge should not care which side of the rename a sender is on.
export const SIGNATURE_HEADER = "x-collattice-signature";
export const EVENT_HEADER = "x-collattice-event";
export const DELIVERY_HEADER = "x-collattice-delivery-id";

export const LEGACY_SIGNATURE_HEADER = "x-collaboard-signature";
export const LEGACY_EVENT_HEADER = "x-collaboard-event";
export const LEGACY_DELIVERY_HEADER = "x-collaboard-delivery-id";

/**
 * Pull the three delivery headers, preferring the current name over the legacy one.
 * Node lowercases incoming header names, so the constants are lowercase.
 *
 * @param {import("node:http").IncomingHttpHeaders} headers
 * @returns {{ signature: string | undefined, event: string | undefined, deliveryId: string | undefined }}
 */
export function readDeliveryHeaders(headers) {
  const pick = (current, legacy) => {
    const value = headers[current] ?? headers[legacy];
    return Array.isArray(value) ? value[0] : value;
  };
  return {
    signature: pick(SIGNATURE_HEADER, LEGACY_SIGNATURE_HEADER),
    event: pick(EVENT_HEADER, LEGACY_EVENT_HEADER),
    deliveryId: pick(DELIVERY_HEADER, LEGACY_DELIVERY_HEADER),
  };
}

/**
 * Verify a Collattice delivery signature: HMAC-SHA256 over the exact raw bytes of
 * the request body, keyed by the shared secret, compared in constant time.
 *
 * The bytes must be the ones that arrived — never a re-serialized copy of the
 * parsed object, because re-serializing can reorder keys or change whitespace and
 * the digest won't match a genuine payload.
 */
export function verifySignature(rawBody, header, secret) {
  if (typeof header !== "string" || header === "") return false;
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const received = Buffer.from(header, "utf8");
  const computed = Buffer.from(expected, "utf8");
  return received.length === computed.length && timingSafeEqual(received, computed);
}

/**
 * @param {import("node:http").IncomingMessage} req
 * @param {number} limit
 * @returns {Promise<Buffer>}
 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        /** @type {Error & { tooLarge?: boolean }} */
        const error = new Error(`body exceeds ${limit} bytes`);
        error.tooLarge = true;
        // Stop reading, but leave the socket alive: the caller still has to write a
        // 413, and destroying here would take the response down with it — Collattice
        // would see a transport failure and retry a delivery that can never succeed.
        // Pausing applies TCP backpressure, so the rest of the upload isn't buffered.
        req.removeAllListeners("data");
        req.pause();
        reject(error);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** How long to keep draining a refused upload before giving up on it. */
const DRAIN_MS = 2_000;

/**
 * Discard the rest of a body we've already decided to refuse, and resolve once the
 * client has stopped sending (or we've waited long enough).
 *
 * This has to finish *before* the refusal is written: a response that closes the
 * connection makes Node tear the socket down the moment it flushes, and a client
 * still mid-upload gets a reset instead of the status we wrote. Draining first
 * means the reply lands on a quiet socket.
 *
 * Bounded on purpose — the bytes are thrown away rather than buffered, and an
 * upload that never ends is answered anyway rather than holding a connection open.
 *
 * @param {import("node:http").IncomingMessage} req
 * @returns {Promise<void>}
 */
function drain(req) {
  return new Promise((done) => {
    const deadline = setTimeout(done, DRAIN_MS);
    deadline.unref();
    const finish = () => {
      clearTimeout(deadline);
      done();
    };
    req.on("data", () => {});
    req.on("end", finish);
    req.on("error", finish);
    req.resume();
  });
}

/**
 * @param {import("node:http").ServerResponse} res
 * @param {number} status
 * @param {string} [body]
 * @param {Record<string, string>} [headers]
 */
function respond(res, status, body = "", headers = {}) {
  if (res.writableEnded) return;
  // RFC 7230 §3.3.2: a 204 carries no body, and framing headers on one are a protocol
  // error that a strict intermediary may record as a failed delivery.
  const framing =
    status === 204
      ? {}
      : { "Content-Type": "text/plain; charset=utf-8", "Content-Length": Buffer.byteLength(body) };
  res.writeHead(status, { ...framing, ...headers });
  res.end(status === 204 ? undefined : body);
}

/**
 * The HTTP surface Collattice posts to.
 *
 * `onEvent` is called with the parsed body *after* the response has already been
 * sent. That ordering is deliberate: Collattice's per-POST delivery timeout is a
 * few seconds and a slow endpoint is recorded as a failed attempt, which triggers
 * retries — so waiting on a destination here would turn destination latency into
 * duplicate messages.
 */
export function createReceiver({ config, onEvent, log }) {
  const { path, maxBodyBytes } = config.listen;
  const secret = config.signing.secret;

  const server = createServer((req, res) => {
    // Node types `req.url` as optional; for a server request it is always present,
    // but default it rather than assert so a malformed request 404s instead of throwing.
    const url = new URL(req.url ?? "/", "http://receiver.invalid");

    if (req.method === "GET" && url.pathname === "/healthz") {
      respond(res, 200, "ok\n");
      return;
    }

    if (url.pathname !== path) {
      respond(res, 404, "not found\n");
      return;
    }

    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      respond(res, 405, "method not allowed\n");
      return;
    }

    readBody(req, maxBodyBytes)
      .then((rawBody) => {
        const delivery = readDeliveryHeaders(req.headers);
        if (secret !== null && !verifySignature(rawBody, delivery.signature, secret)) {
          log.warn("rejected delivery: signature missing or invalid", {
            event: delivery.event,
            deliveryId: delivery.deliveryId,
          });
          respond(res, 401, "invalid signature\n");
          return;
        }

        let payload;
        try {
          payload = JSON.parse(rawBody.toString("utf8"));
        } catch (error) {
          log.warn("rejected delivery: body is not valid JSON", { error: error.message });
          respond(res, 400, "invalid json\n");
          return;
        }

        // Acknowledge first, forward second.
        respond(res, 204);

        try {
          onEvent(payload);
        } catch (error) {
          log.error("event handler threw", { error: error.message });
        }
      })
      .catch(async (error) => {
        if (error.tooLarge) {
          log.warn("rejected delivery: body too large", { limit: maxBodyBytes });
          await drain(req);
          // The body was refused unread, so this connection can't be reused — say so,
          // and Node closes the socket once the 413 has been flushed.
          respond(res, 413, "payload too large\n", { Connection: "close" });
          return;
        }
        log.warn("failed to read request body", { error: error.message });
        respond(res, 400, "bad request\n");
      });
  });

  return server;
}
