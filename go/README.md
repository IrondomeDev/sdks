# IronDome Go SDK

A concurrent client using only the Go standard library. Go 1.23 or newer is
required. One `Client` owns one HTTP transport and its TLS session cache.

## Install

Install the versioned module in your Go project:

```sh
go get github.com/IrondomeDev/sdks/go@v0.1.0
```

```go
package main

import (
    "context"
    "log"
    "os"
    "time"
    irondome "github.com/IrondomeDev/sdks/go"
)

func main() {
    client, err := irondome.New(os.Getenv("IRONDOME_API_KEY"),
        os.Getenv("IRONDOME_BASE_URL"), irondome.Options{})
    if err != nil { log.Fatal("invalid IronDome configuration") }
    defer client.Close()
    ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
    defer cancel()
    result, err := client.Check(ctx, "person@example.com")
    if err != nil { log.Fatal(err) }
    log.Printf("disposable=%t reason=%s", result.Disposable, result.Reason)
}
```

In a server, construct the client once and share it across goroutines. Close at
final shutdown after draining work, not per HTTP handler or Lambda invocation.
`Close` releases idle sockets and rejects new calls; active operations finish under
their contexts. A canceled context is never treated as a classification result.

## Bulk checks

`CheckBulk` checks 1–100 emails in one request and preserves their input order.
Each item contains either a `Result` or an `Error` with code `invalid_email`.

```go
batch, err := client.CheckBulk(ctx, []string{"person@example.com", "invalid"})
if err != nil { log.Fatal(err) }
for _, item := range batch.Results {
    if item.Error != nil {
        log.Printf("item=%d error=%s", item.Index, item.Error.Code)
    } else {
        log.Printf("item=%d disposable=%t", item.Index, item.Result.Disposable)
    }
}
```

Each valid email counts as one check. Bulk request and response bodies are limited
to 64 KiB. Requests are never automatically retried.

Use `https://free.irondome.dev` with a free key or `https://api.irondome.dev` with a
paid key. Change both the endpoint and key when switching plans.

## Transport and warmup

`New` does no network I/O. `Warmup(ctx)` is an optional unauthenticated health GET
on the same pool. Start it ahead of independent initialization only when useful;
do not make health a mandatory preflight for each check. It warms transport state,
not Ed25519 verification, revocation, or detector initialization.

HTTP/2 is negotiated with HTTP/1.1 fallback. `ForceAttemptHTTP2` is explicit because
a custom dialer and TLS configuration are installed. HTTP/1.1 connections are reused
after full bounded body consumption. TLS session resumption is opportunistic and
does not make a new TCP connection disappear. Go's HTTP documentation requires
reuse of clients/transports rather than creation per request.[1]

## Options

Zero values select defaults; negative durations or invalid counts are rejected.

| Field | Default | Behavior |
| --- | --- | --- |
| `Timeout` | 5 seconds | Total HTTP request/body deadline |
| `ConnectTimeout` | 2 seconds | Dial and TLS handshake phase caps |
| `IdleTimeout` | 20 seconds | Idle connection expiry policy |
| `MaxConnections` | 32 | Connections per origin |
| `MaxIdleConnections` | min(8, total) | Idle pool capacity |
| `MaxInFlight` | 64 | Fail-fast operation admission limit |
| `HTTP1Only` | false | Explicit protocol fallback/diagnostic mode |
| `RootCAs` | system roots | Optional trusted certificate pool, cloned during construction |

The earlier of the caller's context and client timeout bounds a call. Preserve
upstream cancellation by passing the real request context, not Background in every
server operation. Limit downstream work before exceeding your handler deadline.
Increasing socket count without measuring concurrency can worsen connection churn.

TLS verification cannot be disabled through this SDK. Minimum TLS is 1.2; the
hostname and chain are verified. The session cache holds up to 64 entries. TCP
keepalive probes do not override remote HTTP idle policies. Proxy is explicitly nil
and cookies are not retained. Supplied RootCAs replace default roots; begin with
`x509.SystemCertPool` when an additional private CA is required.

## Results and errors

`Check(ctx, email)` returns `CheckResult` with Provider, Valid, Disposable, Reason,
RequestID, and DetectorVersion. The server's accepted 200 response must contain
valid=true and consistent reason/disposable fields. `not_listed` does not guarantee
that a mailbox exists, is deliverable, or is safe. `Warmup` returns HealthResult with
diagnostic metadata. See [the API contract](https://irondome.dev/docs/api/check) for provider/reason values.

Use `errors.As(err, &sdkError)` with `var sdkError *irondome.Error`. Its Kind is one
of Configuration, Validation, Protocol, Transport, Timeout, Canceled, Busy, Closed,
or API. API failures include StatusCode, allowlisted Code, RequestID, and optional
RetryAfter duration. Unknown HTTP failures use `http_error`. `errors.Is` recognizes
context.Canceled and context.DeadlineExceeded for their corresponding kinds.

No raw server error message, submitted address, or credential is retained in the
SDK error. Redirects are rejected, compression is not requested or decoded, and
single-check responses are capped at 16 KiB. Requests use a known byte length and
one JSON field (`email` or `emails`). Go's HTML escaping is disabled for a compact wire body; JSON
escaping remains enabled. Invalid UTF-8 and single-check bodies over 1,024 bytes
fail locally; bulk bodies have a 65,536-byte limit.

No SDK retry loop or idempotency header is installed. POST bodies do not expose
GetBody for replay. Go may perform transport-internal recovery only under its own
rules; the SDK does not label a billable POST idempotent.[1] A lost response can
still correspond to a billed success. Do not automatically replay ambiguous calls
or convert a failure into a negative disposable result.

## Deployment and operations

Keep origin/key in trusted server configuration, never inbound URL parameters.
Create separate clients for different credentials; do not mutate a shared client.
Use bounded application-level tenant pooling where necessary. Lambda environments
may preserve the client while warm, but sockets can expire during freeze/thaw.
No background health heartbeat is scheduled by this SDK.

Record only safe metadata and application-observed timings. Keep Authorization,
email bodies, tracing payloads, and certificate private keys out of logs. A redacted
String/GoString is not a defense against arbitrary memory inspection.

## Verification

```sh
go test -race ./...
go vet ./...
test -z "$(gofmt -l .)"
```

Tests use `httptest` TLS servers and explicitly trust their certificates. They
verify one connection is reused with HTTP/1.1 and HTTP/2, concurrent access under
the race detector, cancellation, bounds, error redaction, redirect/no-replay,
cookies, and failed certificate/hostname checks. No production traffic is generated.
See [testing](../TESTING.md) and [latency research](../TESTING.md).

[1]: https://pkg.go.dev/net/http
