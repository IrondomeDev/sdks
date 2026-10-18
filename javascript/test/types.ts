import { IronDome, APIError, type CheckResult, type BulkResult } from "../src/index.js";
import { IronDome as NodeClient } from "../src/node.js";
const client = new IronDome({ baseUrl: "https://example.test", apiKey: "test" });
const node = new NodeClient({ baseUrl: "https://example.test", apiKey: "test", maxSockets: 8 });
const result: Promise<CheckResult> = client.check("person@example.com", { signal: new AbortController().signal });
void result;
void node;
function errorCode(error: unknown): string | undefined { return error instanceof APIError ? error.code : undefined; }
void errorCode;
const bulk: Promise<BulkResult> = node.checkBulk(["a@example.com", "broken"] as const);
void bulk;
// @ts-expect-error Bulk entries must be strings.
client.checkBulk([123]);
// @ts-expect-error Numeric email inputs are not part of the API.
client.check(123);
// @ts-expect-error Node uses its own Agent, not an injected Fetch adapter.
new NodeClient({ baseUrl: "https://example.test", apiKey: "test", fetch });

const unified = new IronDome({ apiKey: "test" });
const unifiedNode = new NodeClient({ apiKey: "test" });
unified.close(); unifiedNode.close();

import { IronDome as DenoClient, DEFAULT_BASE_URL as denoOrigin } from "../src/deno.js";
const unifiedDeno = new DenoClient({ apiKey: "test", caCerts: [] });
const canonicalOrigin: "https://api.irondome.dev" = denoOrigin;
void canonicalOrigin; unifiedDeno.close();
