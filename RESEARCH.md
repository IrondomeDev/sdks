# Official transport references used for the unified SDK migration

The client API targets one opaque bearer credential per account and one canonical origin. The server validates the stable account capability and current account registration; clients do not add entitlement calls or decode tier claims. The stable account-key production rollout is active as of 18 October 2026.

The account key remains unchanged across free/paid plan transitions. The server applies the current plan, sharing 500 free checks per organization and bypassing that quota for paid accounts. Existing tier-bound credentials are rejected after migration; the retired legacy free endpoint returns HTTP 410.

- [Node HTTP Agent](https://nodejs.org/api/http.html#class-httpagent): keep-alive, idle sockets, per-host/total limits and LIFO scheduling support an owned bounded pool. The Node adapter keeps its HTTPS agent and TLS verification; it does not add an HTTP/2 session manager for this endpoint migration.
- [HTTPX clients](https://www.python-httpx.org/advanced/clients/) and [async clients](https://www.python-httpx.org/async/): reuse a Client/AsyncClient for pooling, with explicit cleanup and event-loop ownership. The SDK retains HTTP/2 negotiation, disabled environment proxies/cookies, request bounds and no transport retries.
- [Go net/http Transport](https://pkg.go.dev/net/http#Transport): transports are reusable and safe for concurrent use. Its documented retry rules must not be broadened by adding idempotency headers to billable POSTs. The SDK retains a shared transport, fixed-length bodies, contexts and redirect rejection.
- [Deno custom HTTP clients](https://docs.deno.com/api/deno/fetch/): createHttpClient owns a pool used by Fetch and must be closed. Hosted Supabase functions use the portable Fetch adapter; native Deno APIs are not assumed available there.
- [Reqwest ClientBuilder](https://docs.rs/reqwest/latest/reqwest/struct.ClientBuilder.html): the Rust client retains an owned reusable client, explicit deadlines, disabled redirects/proxies and an explicit never-retry policy.
- [Cargo manifest](https://doc.rust-lang.org/cargo/reference/manifest.html): the package limits its published files to runtime source, manifest/lockfile, README and license.
- [OpenSSL req configuration](https://docs.openssl.org/3.0/man1/openssl-req/): fixture certificates use an explicit CA extension section. Local Windows OpenSSL otherwise produced duplicate basic constraints when machine defaults and added extensions were combined. The fixture now verifies the generated chain before declaring readiness.
- [Python socketserver request queue](https://docs.python.org/3/library/socketserver.html#socketserver.TCPServer.request_queue_size): the local fixture has a bounded backlog sufficient for concurrent client tests instead of inheriting a small platform default.

Connection reuse is verified by local connection identities. Those assertions do not establish global latency percentiles, hosted-platform behavior or a production speedup. No SDK adds a warmup, token exchange, retry, plan lookup or detector cache before normal checks.
