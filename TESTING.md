# Unified SDK validation

These SDKs target the stable account-key contract at `https://api.irondome.dev`; the stable account-key backend is active in production as of 18 October 2026. Tests use local TLS fixtures and synthetic credentials; no D1, production usage or payment calls are required. Current local validation is recorded in `VALIDATION.md`; the historical record below describes earlier runs and is not a claim about current hosted CI.

## Reproducible tests

Run from each language directory:

```sh
# javascript
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run typecheck
deno test --allow-run=python3 --allow-read --allow-net=localhost,127.0.0.1 test/deno.test.js

# python
python -m pip install -e '.[test]'
python -m pytest -q

# go
go test -race ./...
go vet ./...
test -z "$(gofmt -l .)"

# rust
cargo test
cargo clippy --all-targets -- -D warnings
cargo fmt --all -- --check
```

On Windows, use `--allow-run=python` in the Deno command; Unix runners use `python3`.

Node, Python, Rust, and Deno tests start `testing/server.py` on loopback. It creates
an ephemeral loopback-IP certificate/private key using OpenSSL and removes the files
at shutdown. Clients explicitly trust the certificate while preserving hostname
verification. A mismatched host and an untrusted certificate must fail. Private
fixture keys never enter Git. Go uses equivalent `httptest` TLS servers, including
an HTTP/2 configuration. Test credentials are deliberately invalid production keys.

The fixture records socket IDs and counts operations, not credentials or email
bodies. Assertions check that sequential health/check calls reuse one TLS socket,
health has no Authorization, and redirects/503/disconnect failures do not create
additional SDK POSTs. Other cases include exact Content-Length, Unicode, schema and
body bounds, timeout during headers/body/pool wait, cancellation, concurrency,
closed-client behavior, environment-proxy isolation where owned, and cookie isolation.
Not every runtime supports every assertion; review the individual test files.

## Historical verification record

The authoring environment ran Node 22.16.0, TypeScript 5.8.3, Python 3.13.5, and
Go 1.23.2. The initial suites passed: Node 9 test groups plus type checking, Python
48 cases, and Go 7 top-level test groups including HTTP/1.1 and HTTP/2 reuse under
`-race`, plus `go vet`. Rust and Deno were not installed in that environment; their
results must be taken from the PR's CI checks rather than inferred from source review.
The final PR description records additional runs and any unresolved gates.

## CI boundaries

The SDK workflow has read-only repository permissions, no production secrets, no
package publication, and no Fastly deployment. It tests supported runtime versions
and runs local TLS fixtures. It does not call the deployed IronDome service. A green
unit/integration suite is not a regional latency benchmark or a security audit.

Hosted Vercel, Lambda, Supabase, and Cloudflare Workers deployments require an
additional acceptance pass in a controlled account. In particular, verify the
portable Fetch body produces Content-Length at ingress, cancellation closes the
response path, and credentials cannot reach a redirected origin. Do not report
native hosted-platform validation merely because Node executed a Fetch-shaped mock.

## Measuring latency without inventing results

Measure separately: application startup/import cost; client construction/CA loading;
DNS; TCP; TLS; connection pool wait; request-to-first-byte; body completion; and total
end-user operation time. Record runtime version, region, origin, protocol, connection
reuse, sample count, concurrency, pacing, and idle gap. Report cold and warm
populations separately, including errors, timeouts, and canceled requests.

Compare a fresh client/connection, a persistent client without prewarm, and the
same persistent client with health warmup overlapped with required independent
initialization. Charge warmup time to total startup even when it is outside the
interactive critical path. Sequential socket-count assertions prove reuse but not
an improvement of a specific number of milliseconds on the Internet.

Run idle-gap sweeps and freeze/thaw tests to determine when the platform replaces
sockets. Repeat at realistic bounded concurrency; a single warm HTTP/1.1 socket
cannot satisfy arbitrary parallel demand without queueing or new connections.
For HTTP/2, record concurrent streams as well as physical connections.

For production acceptance, use a controlled credential with a strict request cap.
Do not run production load tests while D1 writes are exhausted. Keep any later authorized smoke run explicitly small and bounded. Each successful check may be billable; the API has no
server-backed logical-request idempotency key. Never perform sustained load tests
or speculative duplicate checks as part of normal CI. Keep submitted addresses and
credentials out of traces. Coordinate any high-volume Fastly test separately.

## Release gates

Before registry publication: complete CI, review transport dependencies and license,
pin/review release dependency resolutions, validate generated package contents,
exercise supported hosted runtimes with controlled smoke traffic, and approve the
assigned production origin. Verify deployment-level TLS/ALPN/HTTP/3 settings
independently. Before latency claims: retain real regional measurements and a
reproducible methodology. Before automatic retries: implement a server-backed
idempotency/usage policy and prove its semantics across failures.
