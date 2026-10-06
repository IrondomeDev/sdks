import { BaseClient, MAX_RESPONSE_BYTES, ProtocolError, ConfigurationError } from "./core.js";
export { IronDomeError, APIError, ConfigurationError, ValidationError, ProtocolError,
  TransportError, TimeoutError, CancelledError, BusyError, ClosedError } from "./core.js";

// Native fetch owns DNS, TLS, protocol negotiation, and connection reuse on edge runtimes.
export class IronDome extends BaseClient {
  constructor(options) {
    const fetcher = options.fetch ?? globalThis.fetch;
    if (typeof fetcher !== "function") throw new ConfigurationError("This runtime requires a Fetch implementation.");
    super(options, async ({ url, method, headers, body, signal }) => {
      const response = await fetcher(url, {
        method, headers, body, signal, redirect: "manual", credentials: "omit", cache: "no-store",
      });
      const reader = response.body?.getReader();
      const chunks = [];
      let size = 0;
      try {
        const declared = response.headers.get("content-length");
        if (declared && /^\d+$/.test(declared) && Number(declared) > MAX_RESPONSE_BYTES) {
          throw new ProtocolError("Response exceeds 16384 bytes.");
        }
        if (reader) {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_RESPONSE_BYTES) throw new ProtocolError("Response exceeds 16384 bytes.");
            chunks.push(value);
          }
        }
      } catch (error) {
        if (reader) await reader.cancel().catch(() => {});
        throw error;
      } finally { reader?.releaseLock(); }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return { status: response.status, headers: response.headers, body: bytes };
    });
  }
}
