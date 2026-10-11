import type { ClientOptions, RequestOptions, CheckResult, HealthResult, BulkResult } from "./index.js";
export { IronDomeError, APIError, ConfigurationError, ValidationError, ProtocolError,
  TransportError, TimeoutError, CancelledError, BusyError, ClosedError } from "./index.js";
export type { RequestOptions, CheckResult, HealthResult } from "./index.js";
export interface DenoClientOptions extends Omit<ClientOptions, "fetch"> {
  caCerts?: string[];
  idleTimeoutMs?: number;
  maxIdleConnections?: number;
}
export type { BulkResult, BulkItem, BulkCheckedItem, BulkFailedItem } from "./index.js";
export class IronDome {
  constructor(options: DenoClientOptions);
  check(email: string, options?: RequestOptions): Promise<CheckResult>;
  checkBulk(emails: readonly string[], options?: RequestOptions): Promise<BulkResult>;
  warmup(options?: RequestOptions): Promise<HealthResult>;
  close(): void;
}
