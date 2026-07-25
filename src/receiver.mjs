import { createServer } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_HEADER = "x-collaboard-signature";
export const EVENT_HEADER = "x-collaboard-event";
export const DELIVERY_HEADER = "x-collaboard-delivery-id";

/**
 * Verify a Collaboard delivery signature: HMAC-SHA256 over the exact raw bytes of
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
        req.destroy();
        reject(error);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function respond(res, status, body = "") {
  if (res.writableEnded) return;
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

/**
 * The HTTP surface Collaboard posts to.
 *
 * `onEvent` is called with the parsed body *after* the response has already been
 * sent. That ordering is deliberate: Collaboard's per-POST delivery timeout is a
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
        if (secret !== null && !verifySignature(rawBody, req.headers[SIGNATURE_HEADER], secret)) {
          log.warn("rejected delivery: signature missing or invalid", {
            event: req.headers[EVENT_HEADER],
            deliveryId: req.headers[DELIVERY_HEADER],
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
      .catch((error) => {
        if (error.tooLarge) {
          log.warn("rejected delivery: body too large", { limit: maxBodyBytes });
          respond(res, 413, "payload too large\n");
          return;
        }
        log.warn("failed to read request body", { error: error.message });
        respond(res, 400, "bad request\n");
      });
  });

  return server;
}
