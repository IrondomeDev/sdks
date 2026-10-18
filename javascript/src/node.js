import { Agent, request } from "node:https";
import { BaseClient, MAX_RESPONSE_BYTES, ProtocolError, TransportError, positiveInteger } from "./core.js";
export { DEFAULT_BASE_URL, IronDomeError, APIError, ConfigurationError, ValidationError, ProtocolError,
  TransportError, TimeoutError, CancelledError, BusyError, ClosedError } from "./core.js";

export class IronDome extends BaseClient {
  constructor(options) {
    const sockets = positiveInteger(options.maxSockets ?? 32, "maxSockets", 65536);
    const idle = positiveInteger(options.idleTimeoutMs ?? 20000, "idleTimeoutMs");
    const agent = new Agent({
      keepAlive: true, scheduling: "lifo", maxSockets: sockets, maxTotalSockets: sockets,
      maxFreeSockets: Math.min(8, sockets), timeout: idle, maxCachedSessions: 64,
      minVersion: "TLSv1.2", rejectUnauthorized: true, ca: options.ca,
    });
    try {
      super(options, ({ url, method, headers, body, signal, maxResponseBytes = MAX_RESPONSE_BYTES }) => new Promise((resolve, reject) => {
        const req = request(url, { method, headers: body ? { ...headers, "content-length": body.byteLength } : headers,
          agent, signal, maxHeaderSize: 16384 }, (res) => {
          const chunks = [];
          let size = 0;
          const declared = res.headers["content-length"];
          if (declared && Number(declared) > maxResponseBytes) {
            res.destroy();
            reject(new ProtocolError("Response exceeds its byte limit."));
            return;
          }
          res.on("data", (chunk) => {
            size += chunk.length;
            if (size > maxResponseBytes) {
              reject(new ProtocolError("Response exceeds its byte limit."));
              res.destroy();
            } else chunks.push(chunk);
          });
          res.once("error", () => reject(new TransportError("Response stream failed; delivery may be unknown.")));
          res.once("aborted", () => reject(new TransportError("Response stream ended early; delivery may be unknown.")));
          res.once("end", () => {
            const responseHeaders = new Headers();
            for (const [key, value] of Object.entries(res.headers)) {
              if (value !== undefined) responseHeaders.set(key, Array.isArray(value) ? value.join(", ") : value);
            }
            resolve({ status: res.statusCode ?? 0, headers: responseHeaders, body: Buffer.concat(chunks, size) });
          });
        });
        req.once("socket", (socket) => socket.setNoDelay(true));
        req.once("error", () => reject(new TransportError("Secure request failed; delivery may be unknown.")));
        req.end(body);
      }), () => agent.destroy());
    } catch (error) { agent.destroy(); throw error; }
  }
}
