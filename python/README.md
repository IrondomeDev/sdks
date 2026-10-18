# IronDome Python SDK

Synchronous and asyncio clients backed by owned, reusable HTTPX transports. Python
3.11 or newer is required. PyPI publication is pending account review. Install the tagged source meanwhile.

## Install

```sh
python -m pip install "git+https://github.com/IrondomeDev/sdks.git@javascript/v0.2.0#subdirectory=python"
```

The dependency `httpx[http2]` enables TLS ALPN negotiation for HTTP/2, with HTTP/1.1
fallback. It does not force HTTP/2 against a server that does not offer it.

## Synchronous application

```python
import os
from irondome import Client, APIError

client = Client(
    os.environ['IRONDOME_API_KEY'],
)

def classify_email(email: str):
    try:
        return client.check(email, timeout=3.0)
    except APIError as error:
        # Correlate only safe metadata. Keep email and credentials out of logs.
        print(error.status_code, error.code, error.request_id)
        raise

# At application shutdown, after all worker calls finish:
# client.close()
```

Reuse the client across calls and threads. Do not create a client or enter a new
`with Client(...)` block per request. For a short-lived script, a single context
manager around all operations is appropriate. Construct a new client after a
process fork, not before it. Keep credentials immutable per client.

## Async application and cold-path preparation

```python
import asyncio
import os
from irondome import AsyncClient

async def application():
    async with AsyncClient(os.environ['IRONDOME_API_KEY']) as client:
        # Optional: overlap transport preparation with independent startup work.
        async with asyncio.TaskGroup() as tasks:
            tasks.create_task(client.warmup())
            # Add independently required initialization tasks here.
        result = await client.check('person@example.com', timeout=3.0)
        return result.disposable

# asyncio.run(application()) for a standalone application, not for each server call.
```

Share one AsyncClient within one long-lived asyncio event loop. In ASGI, create it
in application lifespan and close it after draining requests. Do not pass it across
threads/event loops or retain it across repeated `asyncio.run` calls. Caller task
cancellation propagates as `asyncio.CancelledError`, releases admission capacity,
and closes the response context. It is not converted into a successful check.

Warmup is an explicit, unauthenticated `GET /healthz` on the same pool. It sends no
email or key, is not a billable check, and does not verify a key or initialize the
protected detector path. A first-ever TLS connection cannot be skipped safely.
Warmup helps only when useful work can overlap it or starts after it. Putting a
health call immediately before every check adds latency and unnecessary traffic.

## Configuration

Both constructors accept the same keyword options. All durations are seconds.

| Keyword | Default | Meaning |
| --- | --- | --- |
| `base_url` | `https://api.irondome.dev` | Trusted HTTPS origin, no path/query/fragment/userinfo |
| `timeout` | 5.0 | Request budget; see synchronous limitation below |
| `connect_timeout` | 2.0 | Connection phase cap, bounded by the request budget |
| `pool_timeout` | 1.0 | Pool wait cap, bounded by the request budget |
| `max_connections` | 32 | HTTPX connection ceiling |
| `max_keepalive_connections` | 8 | Idle connection ceiling, no greater than total |
| `keepalive_expiry` | 20.0 | Idle pool expiry; server may close sooner |
| `max_in_flight` | 64 | Fail-fast application admission limit |
| `http2` | True | Negotiate HTTP/2 when supported |
| `ssl_context` | verified system trust | Optional trusted SSLContext with verification enabled |

Per-call `timeout=` overrides the request budget for `check` and `warmup`.
The async client uses `asyncio.timeout` around pool acquisition, network work, and
body consumption. The sync client applies HTTPX phase timeouts and checks a
monotonic budget between raw reads. **Its budget is not an interruptible hard
wall-clock deadline**: a blocking resolver/phase/read can run beyond the remaining
budget before control returns. Use the async client and a functioning event loop
when a strict cancellation boundary is required. CPU-bound event-loop blocking
can delay async cancellation too. HTTPX documents separate connect/read/write/pool
timeouts rather than one total synchronous deadline.[1]

Excess calls fail with `BusyError` rather than building an unbounded queue.
Do not raise concurrency until pool wait, request latency, and failure rate have
been measured. HTTP/2 streams and application operations are not socket counts.

## Results and failures

`check(email)` returns an immutable, slotted `CheckResult` with `provider`, `valid`,
`disposable`, `reason`, optional `request_id`, and optional `detector_version`.
The server returns `valid=True` only for an accepted syntax/normalization result;
invalid input is an error. `valid` does not verify mailbox existence, deliverability,
or safety. `not_listed` means no match, not an assurance.

`warmup()` returns `HealthResult(status='ok', ...)`. Check bodies use exactly one
string field, UTF-8 bytes, and a known Content-Length. The complete JSON body must
fit 1,024 bytes. Invalid Unicode and oversize serialization fail before I/O; the
server remains authoritative for email normalization and syntax.

`APIError` has `status_code`, allowlisted `code`, optional `request_id`, and optional
`retry_after_seconds` capped at 86,400. Unrecognized HTTP errors use `http_error`.
Other errors are `ConfigurationError`, `ValidationError`, `ProtocolError`,
`TransportError`, `TimeoutError`, `BusyError`, and `ClosedError`.

There are no automatic retries, redirects, or response/authorization caches.
A disconnect, timeout, or cancellation does not prove the POST was unprocessed.
A new successful POST can create another billable event, even for the same email.
`Retry-After` is exposed for policy decisions but never automatically acted upon.
Fail closed; never substitute a negative disposable result for a transport error.

## Security and lifecycle

The default SSL context verifies hostname and certificate chain and requires TLS
1.2 or newer. A custom context must retain those checks; there is no insecure
switch. Treat supplied contexts as immutable after construction. For a private
CA, load its certificate into a verified context, retain default roots where needed,
and set `minimum_version = ssl.TLSVersion.TLSv1_2` explicitly.[2]

HTTPX environment proxy behavior is disabled, no cookie is persisted or replayed,
and request/response wire bodies are not logged by the SDK. Safe errors do not
retain raw HTTPX request exceptions as context. Client repr redacts the credential;
this does not make a Python process or debugger a secret vault. Prevent tracing
agents from recording Authorization, bodies, or function arguments.

Responses are consumed with a 16 KiB bound or closed on failure. Known-length
oversize responses and unexpected compression are rejected. This protects the
client and avoids leaving a leased response unclosed.[3]

For AWS Lambda, create a synchronous client outside the handler and do not close
it per invocation. Freeze/thaw or execution-environment replacement can require a
new connection. For multitenancy, use a bounded cache of immutable client/config
pairs and close evicted clients only after their work completes; do not mutate a
global API key. Application authentication and rate limits remain your responsibility.

## Tests

```sh
python -m pip install -e '.[test]'
python -m pytest -q
```

The localhost TLS fixture validates trust and hostname failures without turning
off verification. Tests cover sync/async reuse, parallel calls, no transparent
replay, framing/Unicode, cookies/proxy isolation, limits, deadlines, cancellation,
and response schema failures. [Testing](../TESTING.md) identifies platform and
performance validation that still requires an authorized deployment environment.

## Sources

[1]: https://www.python-httpx.org/advanced/timeouts/
[2]: https://docs.python.org/3/library/ssl.html
[3]: https://www.python-httpx.org/advanced/clients/

Also see [HTTPX SSL](https://www.python-httpx.org/advanced/ssl/) and the
[shared latency research](../TESTING.md).

`DEFAULT_BASE_URL` is exported for deployment configuration. One account key and the canonical origin remain unchanged across plan changes; the server applies the current plan. Free accounts share 500 checks per organization per month, while paid accounts bypass that quota. The stable account-key backend is active in production as of 18 October 2026.
