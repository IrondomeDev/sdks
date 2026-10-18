# IronDome JavaScript SDK

[Node.js guide](https://irondome.dev/docs/guides/node) ·
[Serverless integrations](https://irondome.dev/docs/guides/edge-serverless) ·
[API reference](https://irondome.dev/docs/api/check) ·
[Plans and endpoints](https://irondome.dev/docs/plans)

A server-only SDK with one API contract and three transport entry points. The
portable entry has no Node imports or runtime dependencies. The Node adapter owns
an HTTPS connection pool; the Deno adapter owns a native HTTP client.

## Install

```sh
npm install @irondome-dev/sdk@0.2.0
```

Node.js 22 or newer is required for the Node adapter. TypeScript declarations ship
with every entry point. Deno can import `npm:@irondome-dev/sdk@0.2.0/deno`. Keep credentials on the server.

## Endpoints and bulk checks

This SDK targets `https://api.irondome.dev` for one account key across plans;
the stable account-key backend is active in production as of 18 October 2026. The server applies the
current plan without changing the key or API origin. Free accounts share 500
checks per organization per month; each syntactically valid email
in a bulk request counts as one check.

`check(email)` sends one email. `checkBulk(emails)` accepts 1-100 strings,
returns ordered results, and preserves invalid-email errors per item.
Request bodies are limited to 1,024 bytes for single checks and 65,536 bytes
for bulk checks. Neither operation retries automatically.

```js
const batch = await client.checkBulk(['person@example.com', 'invalid']);
for (const item of batch.results) {
  if ('error' in item) console.log(item.index, item.error.code);
  else console.log(item.index, item.disposable);
}
```

## Node.js

```js
import { IronDome, APIError } from '@irondome-dev/sdk/node';

const client = new IronDome({
  apiKey: process.env.IRONDOME_API_KEY,
  timeoutMs: 5000,
});

export async function classifyEmail(email, signal) {
  try {
    return await client.check(email, { signal });
  } catch (error) {
    if (error instanceof APIError) {
      // Safe fields for operational correlation. Do not log email or credentials.
      console.error({ status: error.status, code: error.code, requestId: error.requestId });
    }
    throw error;
  }
}
```

Call this function only inside the application's existing authenticated, authorized,
rate-limited flow. It is not an unauthenticated public proxy. Construct the client
once outside that flow; call `client.close()` at final process shutdown, not after
each check. Closing is idempotent and aborts outstanding calls.

The Node adapter uses HTTP/1.1 deliberately: an owned `https.Agent` provides bounded
sockets, LIFO reuse, session-ticket caching, and a small startup footprint without
a separate HTTP/2 session manager. Small sequential payloads benefit from reuse;
this is not a claim that HTTP/1.1 beats HTTP/2 for every concurrency profile.

## API and results

`await client.check(email, { signal?, timeoutMs? })` sends exactly one fixed-length
UTF-8 JSON body. The 1,024-byte limit includes JSON syntax and escaping, not just
email characters. Invalid Unicode and oversized bodies are rejected before I/O.
Normalization, address syntax, and authorization remain server decisions.

A result has `provider`, `valid: true`, `disposable`, `reason`, optional `requestId`,
and optional `detectorVersion`. Providers are `gmail`, `microsoft`, `icloud`,
`proton`, `yahoo`, or `custom`. Reasons are `blocked_email`, `blocked_domain`,
`allowed_domain`, or `not_listed`. Results are frozen. `valid` does not establish
mailbox existence or deliverability; `not_listed` is not a safety guarantee.

`await client.warmup({ signal?, timeoutMs? })` returns `{ status: 'ok', requestId?,
detectorVersion? }`. It uses the same transport but sends no Authorization header,
email, or billable check. Call it ahead of work only where the runtime allows I/O.
Do not add `await warmup(); await check()` inside every request. An uncached health
round trip on the critical path can make the first operation slower.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `apiKey` | required | Opaque server credential; printable ASCII without whitespace |
| `baseUrl` | `https://api.irondome.dev` | Trusted HTTPS origin, optional trailing slash only |
| `timeoutMs` | 5000 | Request deadline, including pool wait and body read |
| `maxInFlight` | 64 | Admission limit; excess calls fail with `BusyError` |
| `maxSockets` | 32 | Node-only total/per-origin connection ceiling |
| `idleTimeoutMs` | 20000 | Node/Deno idle pool policy, not a durability guarantee |
| `ca` | system trust | Node-only trusted PEM CA material; explicit CA replaces Node's default list |
| `maxIdleConnections` | 8 | Deno-only idle connections per host |
| `caCerts` | system trust | Deno-only additional trusted PEM certificates |
| `fetch` | native fetch | Portable-only trusted Fetch implementation for controlled integration |

All numeric options must be positive integers. In-flight/socket limits are capped
at 65,536. Keep concurrency near measured demand; more sockets are not inherently
faster. Node retains at most eight idle sockets and 64 TLS session entries. A server
or platform may close sockets earlier than the configured idle policy. Do not mutate
custom CA data or replace a trusted Fetch implementation after construction.

## Vercel Functions

Use `@irondome-dev/sdk/node` in the Node.js runtime. Create a module-scoped client, keep
configuration immutable, and reuse it across concurrent invocations in one warm
instance. Do not call `close` in a request's `finally` block: other invocations may
still be using the pool. Use the portable entry in a Fetch-only runtime instead.

Network warmup must be attached to an actual supported initialization/request
lifecycle. A module import alone opens no socket. Fluid compute can reuse instances,
but neither a warm instance nor an open socket is guaranteed. Vercel's database
pool helpers are not generic HTTPS-agent lifecycle hooks.[1]

## AWS Lambda

Use a module-scoped Node client. Set each check's `timeoutMs` below
`context.getRemainingTimeInMillis()` with room for your handler to return. Never
close the shared client on every handler return. Freeze/thaw can invalidate idle
connections; a failed POST is returned to the application rather than replayed.
Creating a client during initialization is not network prewarming by itself.[2]

For Python Lambda, use the synchronous Python client outside the handler. Do not
retain an asyncio client across handlers that call `asyncio.run` separately.

## Deno

```js
import { IronDome } from './vendor/irondome/src/deno.js';
const client = new IronDome({
  apiKey: Deno.env.get('IRONDOME_API_KEY'),
});
try {
  const result = await client.check('person@example.com');
  console.log({ disposable: result.disposable, reason: result.reason });
} finally {
  client.close();
}
```

Grant only the necessary `--allow-env=IRONDOME_API_KEY` and
`--allow-net=api.irondome.dev` permissions. The dedicated Deno client negotiates
HTTP/1.1 or HTTP/2, retains idle connections, and closes owned resources explicitly.
It requires `Deno.createHttpClient`; the portable entry is the fallback where that
API is unavailable. Native Fetch/Deno still controls DNS and TLS implementation.[3]

## Supabase Edge Functions

Use the portable `src/index.js` entry, vendored with its sibling `core.js`, inside
the existing authorized function flow. Read `IRONDOME_API_KEY` from Supabase secrets; the origin defaults to the unified API. Do not assume all Deno native socket APIs are exposed by the
hosted runtime. The Fetch implementation owns pooling, negotiation, and teardown.
An SDK object is cheap and performs no I/O during construction. Platform cold starts
and instance replacement remain outside SDK control.[4]

## Cloudflare Workers

Use the portable entry. Construct it within the request invocation after reading
trusted bindings, and keep I/O within that invocation. Creating a new portable
client does not create a new transport pool: Workers owns the sockets. Do not share
in-flight warmup promises, response streams, or AbortControllers across requests.
The example `examples/cloudflare-workers.js` shows this integration boundary.

The SDK supplies `Uint8Array` bodies so Workers can derive Content-Length. A generic
ReadableStream would be chunked and would not satisfy the current IronDome API.
Setting Content-Length manually is not a reliable Workers workaround. Do not set
`Connection`, pin IPs, or install a Node agent in this entry.[5]

Workers limits pending outbound connections; start with `maxInFlight: 4` for a
single invocation and reserve capacity for other dependencies. Adjust measured
application fan-out, not a claim of owning four permanent TCP sockets. Do not issue
Fetch calls at module initialization just to prewarm a connection.[6]

## Errors, retries, and privacy

`APIError` exposes `status`, allowlisted `code`, optional `requestId`, and optional
`retryAfterSeconds` (0 to 86,400). An unknown or non-JSON HTTP failure is
`http_error`; untrusted response messages are discarded. Redirects are failures,
not followed. `Retry-After` is diagnostic and never initiates a retry.

Other classes are `ConfigurationError`, `ValidationError`, `ProtocolError`,
`TransportError`, `TimeoutError`, `CancelledError`, `BusyError`, and `ClosedError`.
A timeout/cancellation/disconnect can occur after the server billed a successful
check. Do not retry blindly or turn an error into `disposable: false`. There is no
server-backed idempotency facility in this contract. Native runtime transport
recovery is outside a portable Fetch adapter's direct control; the SDK issues one
Fetch call and does not configure early data or retries.

Response bodies are bounded to 16 KiB and consumed or canceled so resources can be
released. TLS certificate and hostname verification remain enabled. Node requires
TLS 1.2 or newer; managed Fetch follows the platform's secure transport policy.
No cookie jar, classification cache, authorization cache, telemetry, or heartbeat
is installed. Node does not implicitly use environment HTTP proxies. Managed Fetch
proxy/routing behavior belongs to the runtime. Custom Fetch is a trusted extension,
not a security sandbox: it must honor HTTPS, abort, redirect, and credential options.

Safe exception messages cannot prevent third-party tracing agents from capturing
arguments or headers. Disable body/header tracing and redact local variables at
the application boundary. A plan change keeps the same key and client. When the
credential itself is replaced, create a new client; do not mutate a shared
credential for concurrent tenants.

## Test and release

```sh
npm install --ignore-scripts
npm test
npm run typecheck
deno test --allow-run=python3 --allow-read --allow-net=localhost,127.0.0.1 test/deno.test.js
```

Tests generate ephemeral localhost TLS certificates and verify successful trust,
failed trust/hostname, connection reuse, framing, safe errors, no SDK replay,
timeouts, admission limits, cookies, and streamed-body limits. Native hosted
Workers/Supabase/Vercel/Lambda deployment tests are a separate acceptance gate.
See [testing](../TESTING.md) and [research](../TESTING.md).

## Sources

[1]: https://vercel.com/docs/fluid-compute
[2]: https://docs.aws.amazon.com/lambda/latest/dg/best-practices.html
[3]: https://docs.deno.com/api/deno/fetch/
[4]: https://supabase.com/docs/guides/functions/architecture
[5]: https://developers.cloudflare.com/workers/runtime-apis/request/
[6]: https://developers.cloudflare.com/workers/runtime-apis/fetch/

Transport APIs: [Node HTTPS](https://nodejs.org/api/https.html),
[Node HTTP Agent](https://nodejs.org/api/http.html), and
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/).
