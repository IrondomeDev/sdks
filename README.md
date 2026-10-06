# IronDome client SDKs

Official SDK source for [IronDome](https://irondome.dev), maintained in
[`IrondomeDev/sdks`](https://github.com/IrondomeDev/sdks). MIT licensed.
These packages are unreleased. See [the release plan](RELEASING.md).

Server-side clients for `POST /v1/check`, with explicit transport warmup through
unauthenticated `GET /healthz`. The clients follow [the customer contract](https://irondome.dev/docs/api/check).
They do not change the detector, authentication, policy, usage ledger, or deployment.

| Language | Documentation | Transport |
| --- | --- | --- |
| Python 3.11+ | [Python guide](python/README.md) | Owned HTTPX sync/async pool; HTTP/2 negotiation |
| JavaScript | [JavaScript guide](javascript/README.md) | Node HTTPS agent; portable Fetch; dedicated Deno client |
| Go 1.23+ | [Go guide](go/README.md) | Owned standard-library HTTP transport; HTTP/2 negotiation |
| Rust | [Rust guide](rust/README.md) | Shared asynchronous reqwest/rustls client; HTTP/2 negotiation |

The JavaScript guide covers Node.js, Vercel Functions, AWS Lambda, Deno,
Supabase Edge Functions, and Cloudflare Workers separately. Each language has its
own folder. JavaScript runtimes share protocol validation rather than maintaining
six divergent copies of the API contract.

## Connection strategy

Reuse one owned client per process and immutable origin/credential configuration.
Python async clients belong to one event loop; Rust clones share the same pool.
Portable Fetch clients do not own sockets. In Cloudflare Workers, construct a cheap
request-scoped client and let the platform manage its network pool.

Constructors perform no network I/O. Call `warmup` explicitly ahead of independent
application work, not automatically before each check. Warmup sends no API key or
email and is not a billable check. It can establish DNS/TCP/TLS state for reuse, but
it does not prove authorization or warm the detector/policy code. A first-ever
secure connection still needs a handshake. Eviction, freeze/thaw, idle expiry,
network changes, and server closure can require another connection.

No SDK enables TLS early data, follows redirects, installs transparent POST retries,
or caches classification/authorization results. A timed-out POST may have succeeded
and been billed. Do not blindly retry it. Read [the research](TESTING.md) before
setting performance expectations or changing these policies.

## Configuration and distribution

Require `IRONDOME_BASE_URL` from trusted server configuration and
`IRONDOME_API_KEY` from a secret store. Use the HTTPS origin assigned to the account;
there is deliberately no invented production domain or default deployment host.
Never derive either value from an unauthenticated inbound request. Keep API keys out
of browser bundles, public environment-variable prefixes, logs, and exception locals.

These are source packages, not a claim that registry names are published. Install
from this checkout using each guide. Node and Rust publication remain disabled
until release checks and registry configuration are complete. No package is
published and no Fastly service is deployed by SDK CI.

The free base URL is `https://free.irondome.dev`; paid uses
`https://api.irondome.dev`. Switching plans requires both a new key and base URL.
Current clients support single checks and warmup. The deployed
[bulk REST endpoint](https://irondome.dev/docs/api/bulk) still needs SDK helpers.

## Verification

[Testing and measurement](TESTING.md) explains the local TLS fixture, exact commands,
coverage boundaries, and production acceptance gates. The fixture generates a
short-lived localhost certificate and explicitly trusts it; tests never disable
certificate or hostname verification. All traffic in the test suites is local.

The CI workflow validates language versions independently. Live regional latency,
platform deployment smoke checks, HTTP/3, DNS routing, and global revocation are not
established by localhost tests. Review those separately before a public release.
