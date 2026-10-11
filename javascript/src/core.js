const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
export const MAX_RESPONSE_BYTES = 16 * 1024;
export const MAX_BULK_BYTES = 64 * 1024;
const providers = new Set(["gmail", "microsoft", "icloud", "proton", "yahoo", "custom"]);
const reasons = new Set(["blocked_email", "blocked_domain", "allowed_domain", "not_listed"]);
const codes = new Set(("empty_body invalid_content_length invalid_body_length invalid_json " +
  "authorization_required invalid_authorization invalid_api_key expired_api_key inactive_api_key " +
  "revoked_api_key insufficient_scope not_found method_not_allowed content_length_required " +
  "body_too_large invalid_email internal_error service_unavailable monthly_quota_exceeded empty_batch batch_too_large").split(" "));

export class IronDomeError extends Error {
  constructor(message) { super(message); this.name = new.target.name; }
}
export class ConfigurationError extends IronDomeError {}
export class ValidationError extends IronDomeError {}
export class ProtocolError extends IronDomeError {}
export class TransportError extends IronDomeError {}
export class TimeoutError extends TransportError {}
export class CancelledError extends TransportError {}
export class BusyError extends IronDomeError {}
export class ClosedError extends IronDomeError {}
export class APIError extends IronDomeError {
  constructor(status, code, requestId, retryAfterSeconds) {
    super(`IronDome request failed (HTTP ${status}, ${code}).`);
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function positiveInteger(value, name, max = 2147483647) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new ConfigurationError(`${name} must be a positive integer within its supported range.`);
  }
  return value;
}

function origin(value) {
  try {
    if (typeof value !== "string" || !/^https:\/\/[^/?#\\\s]+\/?$/iu.test(value)) throw new Error();
    const url = new URL(value);
    if (url.protocol !== "https:" || !url.hostname || url.port === "0" || url.username || url.password ||
        value.includes("@") || url.pathname !== "/") throw new Error();
    return url.origin;
  } catch {
    throw new ConfigurationError("baseUrl must be an HTTPS origin without credentials, path, query, or fragment.");
  }
}

function metadata(value) {
  return value && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : undefined;
}

function retryAfter(value) {
  if (!value || value.length > 128) return undefined;
  const seconds = /^\d+$/.test(value) ? Number(value) : (Date.parse(value) - Date.now()) / 1000;
  return Number.isFinite(seconds) ? Math.min(86400, Math.max(0, Math.ceil(seconds))) : undefined;
}

function checkFields(data) {
  if (!data || typeof data !== "object" || Array.isArray(data) ||
      !providers.has(data.provider) || !reasons.has(data.reason) || data.valid !== true ||
      typeof data.disposable !== "boolean" ||
      data.disposable !== (data.reason === "blocked_email" || data.reason === "blocked_domain")) {
    throw new ProtocolError("Invalid check response.");
  }
  return { provider: data.provider, valid: true, disposable: data.disposable, reason: data.reason };
}

function parseResponse(response, health, bulkCount = 0) {
  const { status, headers, body } = response;
  const requestId = metadata(headers.get("x-request-id"));
  const detectorVersion = metadata(headers.get("x-detector-base-version"));
  if (body.byteLength > (bulkCount ? MAX_BULK_BYTES : MAX_RESPONSE_BYTES)) throw new ProtocolError("Response exceeds its byte limit.");
  const encoding = headers.get("content-encoding");
  if (encoding && encoding.toLowerCase() !== "identity") {
    throw new ProtocolError("Unexpected response content encoding.");
  }
  let data;
  try {
    if (headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
      throw new Error();
    }
    data = JSON.parse(decoder.decode(body));
  } catch {
    if (status === 200) throw new ProtocolError("Expected a UTF-8 JSON response.");
  }
  if (status !== 200) {
    const code = codes.has(data?.error?.code) ? data.error.code : "http_error";
    throw new APIError(status, code, requestId, retryAfter(headers.get("retry-after")));
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new ProtocolError("Invalid response schema.");
  }
  if (health) {
    if (data.status !== "ok") throw new ProtocolError("Invalid health response.");
    return Object.freeze({ status: "ok", requestId, detectorVersion });
  }
  if (bulkCount) {
    if (!Array.isArray(data.results) || data.results.length !== bulkCount ||
        !Number.isInteger(data.checked) || !Number.isInteger(data.failed) ||
        data.checked < 0 || data.failed < 0 || data.checked + data.failed !== bulkCount) {
      throw new ProtocolError("Invalid bulk response.");
    }
    let checked = 0;
    const results = data.results.map((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item) || item.index !== index) {
        throw new ProtocolError("Invalid bulk result index.");
      }
      if (Object.hasOwn(item, "error")) {
        if (item.error?.code !== "invalid_email" || ["provider", "valid", "disposable", "reason"].some(key => Object.hasOwn(item, key))) {
          throw new ProtocolError("Invalid bulk item error.");
        }
        return Object.freeze({ index, error: Object.freeze({ code: "invalid_email", message: "Provide a syntactically valid email address." }) });
      }
      checked++;
      return Object.freeze({ index, ...checkFields(item) });
    });
    if (checked !== data.checked) throw new ProtocolError("Invalid bulk result counts.");
    return Object.freeze({ results: Object.freeze(results), checked, failed: bulkCount - checked, requestId, detectorVersion });
  }
  return Object.freeze({ ...checkFields(data), requestId, detectorVersion });
}

// Transport ownership stays with each client. No mutable credential globals are used.
export class BaseClient {
  #origin; #authorization; #send; #dispose; #timeout; #maxInFlight;
  #active = new Set(); #closed = false;
  constructor(options, send, dispose = () => {}) {
    this.#origin = origin(options.baseUrl);
    if (typeof options.apiKey !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(options.apiKey)) {
      throw new ConfigurationError("apiKey must contain 1 to 4096 printable ASCII characters without spaces.");
    }
    this.#authorization = `Bearer ${options.apiKey}`;
    this.#timeout = positiveInteger(options.timeoutMs ?? 5000, "timeoutMs");
    this.#maxInFlight = positiveInteger(options.maxInFlight ?? 64, "maxInFlight", 65536);
    this.#send = send;
    this.#dispose = dispose;
  }
  async check(email, options = {}) {
    if (typeof email !== "string" || email.length > 1024) {
      throw new ValidationError("email must be a string fitting in a 1024-byte JSON body.");
    }
    for (const character of email) {
      const code = character.codePointAt(0);
      if (code >= 0xd800 && code <= 0xdfff) throw new ValidationError("email must contain valid Unicode.");
    }
    const body = encoder.encode(JSON.stringify({ email }));
    if (body.byteLength > 1024) throw new ValidationError("Request body exceeds 1024 bytes.");
    return this.#request(false, body, options);
  }
  async warmup(options = {}) { return this.#request(true, undefined, options); }
  async checkBulk(emails, options = {}) {
    if (!Array.isArray(emails) || emails.length < 1 || emails.length > 100) {
      throw new ValidationError("Provide between 1 and 100 email strings.");
    }
    let chars = 0;
    for (const email of emails) {
      if (typeof email !== "string" || (chars += email.length) > MAX_BULK_BYTES) {
        throw new ValidationError("Bulk request exceeds its input limit.");
      }
      for (const character of email) {
        const code = character.codePointAt(0);
        if (code >= 0xd800 && code <= 0xdfff) throw new ValidationError("Emails must contain valid Unicode.");
      }
    }
    const body = encoder.encode(JSON.stringify({ emails }));
    if (body.byteLength > MAX_BULK_BYTES) throw new ValidationError("Bulk request body exceeds 65536 bytes.");
    return this.#request(false, body, options, emails.length);
  }
  async #request(health, body, options, bulkCount = 0) {
    if (this.#closed) throw new ClosedError("Client is closed.");
    if (options.signal?.aborted) throw new CancelledError("Request was cancelled.");
    if (this.#active.size >= this.#maxInFlight) throw new BusyError("Client in-flight limit reached.");
    const timeout = positiveInteger(options.timeoutMs ?? this.#timeout, "timeoutMs");
    const controller = new AbortController();
    let timedOut = false;
    const cancel = () => controller.abort();
    options.signal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout);
    this.#active.add(controller);
    try {
      const headers = {
        accept: "application/json", "accept-encoding": "identity", "cache-control": "no-store",
      };
      if (!health) {
        headers.authorization = this.#authorization;
        headers["content-type"] = "application/json";
      }
      const response = await this.#send({ url: this.#origin + (health ? "/healthz" : bulkCount ? "/v1/check/bulk" : "/v1/check"),
        method: health ? "GET" : "POST", headers, body, signal: controller.signal,
        maxResponseBytes: bulkCount ? MAX_BULK_BYTES : MAX_RESPONSE_BYTES });
      if (controller.signal.aborted) throw new CancelledError("Request was cancelled.");
      return parseResponse(response, health, bulkCount);
    } catch (error) {
      if (timedOut) throw new TimeoutError("Request deadline exceeded.");
      if (controller.signal.aborted) throw new CancelledError("Request was cancelled.");
      if (error instanceof IronDomeError) throw error;
      // Transport exceptions can contain URLs, headers, or bodies. Do not retain them.
      throw new TransportError("Secure request failed. Delivery may be unknown; no SDK retry was made.");
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", cancel);
      this.#active.delete(controller);
    }
  }
  close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const controller of this.#active) controller.abort();
    this.#dispose();
  }
}
