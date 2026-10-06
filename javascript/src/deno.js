import { IronDome as FetchClient } from "./index.js";
import { ConfigurationError, positiveInteger } from "./core.js";
export { IronDomeError, APIError, ConfigurationError, ValidationError, ProtocolError,
  TransportError, TimeoutError, CancelledError, BusyError, ClosedError } from "./core.js";

// Use this adapter only where Deno.createHttpClient is available. Supabase uses index.js.
export class IronDome extends FetchClient {
  #http;
  #closed = false;
  constructor(options) {
    if (!globalThis.Deno?.createHttpClient) throw new ConfigurationError("This adapter requires Deno.createHttpClient.");
    if (options.caCerts !== undefined && (!Array.isArray(options.caCerts) ||
        options.caCerts.some((cert) => typeof cert !== "string"))) {
      throw new ConfigurationError("caCerts must be an array of trusted PEM certificates.");
    }
    let http;
    try {
      http = globalThis.Deno.createHttpClient({ http1: true, http2: true,
        poolIdleTimeout: positiveInteger(options.idleTimeoutMs ?? 20000, "idleTimeoutMs"),
        poolMaxIdlePerHost: positiveInteger(options.maxIdleConnections ?? 8, "maxIdleConnections", 65536),
        caCerts: options.caCerts });
    } catch (error) {
      if (error instanceof ConfigurationError) throw error;
      throw new ConfigurationError("Unable to create a verified Deno HTTP client.");
    }
    try {
      super({ ...options, fetch: (url, init) => globalThis.fetch(url, { ...init, client: http }) });
    } catch (error) { http.close(); throw error; }
    this.#http = http;
  }
  close() {
    if (this.#closed) return;
    this.#closed = true;
    super.close();
    this.#http.close();
  }
}
