# IronDome Rust SDK

[Rust integration guide](https://irondome.dev/docs/guides/rust) ·
[API reference](https://irondome.dev/docs/api/check) ·
[Plans and endpoints](https://irondome.dev/docs/plans)

An asynchronous client built on reqwest and rustls. Cloning `Client` shares the
connection pool, immutable credentials, and concurrency admission limit. The SDK
uses a separate Cargo workspace so native HTTP dependencies do not affect the
Fastly Wasm application.

## Install from source

This crate is not published. Add a local dependency to a Tokio application:

```toml
[dependencies]
irondome-sdk = { path = "/absolute/path/to/sdks/rust" }
tokio = { version = "1", features = ["macros", "rt-multi-thread"] }
```

```rust
use irondome_sdk::{Client, Options};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let client = Client::new(
        &std::env::var("IRONDOME_API_KEY")?,
        &std::env::var("IRONDOME_BASE_URL")?,
        Options::default(),
    )?;
    let result = client.check("person@example.com").await?;
    println!("disposable={} reason={:?}", result.disposable, result.reason);
    Ok(())
}
```

Use a timer-enabled Tokio runtime. Construct once inside application initialization,
clone for concurrent tasks, and retain it across checks. Drop all clones after work
completes. Creating a reqwest client per request throws away the pool. There is no
blocking Rust wrapper and this native client is not a Fastly/Wasm runtime adapter.

## Cold-start and connection behavior

Construction performs no network I/O. `client.warmup().await` optionally sends an
unauthenticated health GET using the same pool. It does not submit a billable email
or validate authorization. Overlap it with independent initialization; do not insert
an extra health round trip before every check. True cold connection setup remains
necessary, and health cannot guarantee a subsequent request uses the same Fastly
sandbox or initialized detector/policy state.

TLS ALPN permits HTTP/2 with HTTP/1.1 fallback. TCP_NODELAY is enabled for small
messages; idle connections are retained with a bound. This does not pin a POP or
keep a socket alive across process destruction. HTTP/3/0-RTT, active heartbeat
pings, IP pinning, and hand-written TLS are intentionally absent.

## Configuration

Pass `Options { field: value, ..Options::default() }`.

| Field | Default | Meaning |
| --- | --- | --- |
| `timeout` | 5 seconds | Total request deadline through response-body completion |
| `connect_timeout` | 2 seconds | Connection establishment cap |
| `idle_timeout` | 20 seconds | Idle connection expiry policy |
| `max_idle_connections` | 8 | Idle pool capacity per host |
| `max_in_flight` | 64 | Shared fail-fast admission limit across clones |
| `http1_only` | false | Explicit HTTP/1.1 diagnostic/fallback mode |
| `additional_root_certificates` | empty | Trusted PEM root certificates merged into trust |

Durations must be positive and at most one day. Admission is bounded to 65,536;
idle capacity must be positive and no greater than admission. Active connection
count is bounded indirectly by admitted operations, not by a separate socket-count
option. An idle-pool bound is not an active HTTP/2 stream bound.

For a shorter individual deadline, wrap the operation in `tokio::time::timeout`.
Dropping or aborting the operation cancels its future and releases its admission
permit. The server may already have completed a canceled POST. Do not infer that
cancellation means no usage event was emitted.

## Contract and failure handling

`check(&str)` serializes a single email field without normalization. The complete
UTF-8 JSON body must fit 1,024 bytes. Rust strings already guarantee valid UTF-8;
serialization overhead still counts. A verified result includes typed Provider and
Reason enums, valid, disposable, and optional request_id and detector_version.
Invalid/missing fields or inconsistent reason/disposable combinations are protocol
errors. `valid` means accepted syntax/normalization, not mailbox deliverability.

`Error::Api` exposes status, allowlisted code, request_id, and optional retry_after.
Unknown HTTP errors use `http_error`; raw body messages are not retained. Other
variants are Configuration, Validation, Protocol, Transport, Timeout, and Busy.
All variants have safe Display messages. Client Debug output redacts credentials,
and the Authorization header is marked sensitive in reqwest.

Requests are HTTPS-only, redirects and implicit environment proxies are disabled,
certificate/hostname verification remains enabled, and TLS minimum is 1.2. Explicit
`tls_sslkeylogfile(false)` avoids enabling session-key logging from environment
configuration. Custom CA certificates extend trust; they do not disable validation.
No cookie jar is enabled. Unexpected compression and bodies over 16 KiB fail closed.
Bodies are fully consumed or dropped to release transport resources.

The client explicitly selects `reqwest::retry::never()`: current reqwest has a
protocol-NACK retry policy by default. Do not assume a library has no retries merely
because application code has no loop. No Idempotency-Key header, classification
cache, or authorization cache is added. A response lost after a successful POST can
still be billable, and a new POST is a distinct request.[1]

## Concurrency and deployment

Use client clones inside a bounded task fan-out. `Error::Busy` signals local
admission exhaustion, not a service classification. Keep keys/origins in trusted
configuration and create new immutable clients on rotation. Never overwrite one
shared credential for simultaneous tenants. Prevent tracing libraries from recording
request bodies or headers; redacted SDK errors cannot control external instrumentation.

For a serverless Rust process, preserve a client while its runtime stays alive and
set deadlines below invocation expiry. Platform freeze/thaw, idle socket closure,
DNS/routing changes, and instance replacement can require new connections. There
is no SDK promise of immortal TCP state or a particular regional p99 improvement.

## Test and review

```sh
cargo test
cargo clippy --all-targets -- -D warnings
cargo fmt --all -- --check
```

Integration tests use the shared Python localhost TLS fixture with a generated
trusted certificate. They cover reuse across clones, trust/hostname failures,
redirect/no-replay behavior, body/schema limits, deadlines, and dropped-future
cancellation. Tests require Python 3 and OpenSSL as well as Rust. No production
credential or network endpoint is used. [Testing](../TESTING.md) distinguishes CI
verification from hosted-runtime and production latency acceptance.

[1]: https://docs.rs/reqwest/latest/reqwest/struct.ClientBuilder.html

See [reqwest retry::never](https://docs.rs/reqwest/latest/reqwest/retry/fn.never.html)
and [the shared research](../TESTING.md).
