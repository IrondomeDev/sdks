export declare const DEFAULT_BASE_URL: "https://api.irondome.dev";
export interface ClientOptions {
  /** Defaults to api.irondome.dev. Override only for trusted staging/test origins. */
  baseUrl?: string;
  apiKey: string;
  /** End-to-end deadline including pool wait and response body. Default: 5000. */
  timeoutMs?: number;
  /** Reject excess calls rather than growing an unbounded queue. Default: 64. */
  maxInFlight?: number;
  /** Trusted runtime adapter. Must honor abort, redirects, and credentials options. */
  fetch?: typeof globalThis.fetch;
}
export interface RequestOptions { signal?: AbortSignal; timeoutMs?: number; }
export interface Metadata { readonly requestId?: string; readonly detectorVersion?: string; }
export interface CheckResult extends Metadata {
  readonly provider: "gmail" | "microsoft" | "icloud" | "proton" | "yahoo" | "custom";
  readonly valid: true;
  readonly disposable: boolean;
  readonly reason: "blocked_email" | "blocked_domain" | "allowed_domain" | "not_listed";
}
export interface BulkCheckedItem extends Omit<CheckResult, keyof Metadata> { readonly index: number; }
export interface BulkFailedItem {
  readonly index: number;
  readonly error: { readonly code: "invalid_email"; readonly message: string; };
}
export type BulkItem = BulkCheckedItem | BulkFailedItem;
export interface BulkResult extends Metadata {
  readonly results: readonly BulkItem[];
  readonly checked: number;
  readonly failed: number;
}
export interface HealthResult extends Metadata { readonly status: "ok"; }
export class IronDome {
  constructor(options: ClientOptions);
  check(email: string, options?: RequestOptions): Promise<CheckResult>;
  checkBulk(emails: readonly string[], options?: RequestOptions): Promise<BulkResult>;
  warmup(options?: RequestOptions): Promise<HealthResult>;
  /** Abort active calls and release owned resources. Do not call per invocation. */
  close(): void;
}
export class IronDomeError extends Error {}
export class ConfigurationError extends IronDomeError {}
export class ValidationError extends IronDomeError {}
export class ProtocolError extends IronDomeError {}
export class TransportError extends IronDomeError {}
export class TimeoutError extends TransportError {}
export class CancelledError extends TransportError {}
export class BusyError extends IronDomeError {}
export class ClosedError extends IronDomeError {}
export class APIError extends IronDomeError {
  readonly status: number;
  readonly code: string;
  readonly requestId?: string;
  readonly retryAfterSeconds?: number;
}
