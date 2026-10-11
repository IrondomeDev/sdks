import type { ClientOptions, RequestOptions, CheckResult, HealthResult, BulkResult } from "./index.js";
export { IronDomeError, APIError, ConfigurationError, ValidationError, ProtocolError,
  TransportError, TimeoutError, CancelledError, BusyError, ClosedError } from "./index.js";
export interface NodeClientOptions extends Omit<ClientOptions, "fetch"> {
  maxSockets?: number;
  idleTimeoutMs?: number;
  /** Explicit trusted CA certificates. Certificate and hostname verification stay enabled. */
  ca?: string | Uint8Array | Array<string | Uint8Array>;
}
export type { BulkResult, BulkItem, BulkCheckedItem, BulkFailedItem } from "./index.js";
export class IronDome {
  constructor(options: NodeClientOptions);
  check(email: string, options?: RequestOptions): Promise<CheckResult>;
  checkBulk(emails: readonly string[], options?: RequestOptions): Promise<BulkResult>;
  warmup(options?: RequestOptions): Promise<HealthResult>;
  close(): void;
}
