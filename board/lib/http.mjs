// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * http.mjs — small node:http helpers for the AMP Board server.
 *   json()          JSON response with no-store caching
 *   readBody()      bounded JSON body reader (400 on malformed input)
 *   isLoopbackHost  Host-header guard (DNS-rebinding defence for a 127.0.0.1 server)
 *   serveStatic     whitelist static file server rooted in board/public
 *   createSse       one broadcaster for GET /api/events
 */

import { createReadStream, statSync } from "node:fs";
import path from "node:path";

export const DEFAULT_PORT = 7345;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  res.end(text);
}

export function noContent(res) {
  res.writeHead(204, { "cache-control": "no-store" });
  res.end();
}

export const BODY_LIMIT = 1024 * 1024;

export function readBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, "body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return reject(new HttpError(400, "body must be a JSON object"));
        resolve(parsed);
      } catch {
        reject(new HttpError(400, "invalid JSON body"));
      }
    });
    req.on("error", (err) => reject(new HttpError(400, err.message)));
  });
}

const LOOPBACK_HOST_RE = /^(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/i;

export function isLoopbackHost(host) {
  return typeof host === "string" && LOOPBACK_HOST_RE.test(host.trim());
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

/**
 * Serve a file from an explicit whitelist: { "/": "<abs index.html>", "/app.js": ... }.
 * Anything not in the table is a 404 — no directory walking, no traversal.
 */
export function serveStatic(res, urlPath, files) {
  const file = files[urlPath];
  if (!file) return false;
  let st;
  try {
    st = statSync(file);
  } catch {
    return false;
  }
  res.writeHead(200, {
    "content-type": MIME[path.extname(file)] || "application/octet-stream",
    "content-length": st.size,
    "cache-control": "no-cache",
    "x-content-type-options": "nosniff",
  });
  createReadStream(file).pipe(res);
  return true;
}

/** Server-sent events broadcaster. */
export function createSse({ heartbeatMs = 25_000 } = {}) {
  const clients = new Set();
  const timer = setInterval(() => {
    for (const res of clients) res.write(": ping\n\n");
  }, heartbeatMs);
  timer.unref();

  function handle(req, res, hello = {}) {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(`event: hello\ndata: ${JSON.stringify(hello)}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
  }

  function send(event, data) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(frame);
  }

  function close() {
    clearInterval(timer);
    for (const res of clients) res.end();
    clients.clear();
  }

  return { handle, send, close, get size() { return clients.size; } };
}

/** Trailing-edge throttle keyed by an id (used for `log` events). */
export function throttleByKey(fn, ms) {
  const pending = new Map();
  return (key, value) => {
    if (pending.has(key)) {
      pending.get(key).value = value;
      return;
    }
    const entry = { value };
    pending.set(key, entry);
    setTimeout(() => {
      pending.delete(key);
      fn(key, entry.value);
    }, ms).unref();
  };
}
