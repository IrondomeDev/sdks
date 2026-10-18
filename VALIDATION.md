# Unified SDK validation — status updated 18 October 2026

Scope: unified SDK fixture tests. These use synthetic credentials and make no production, D1 or payment calls.

## Completed local checks

| Client | Runtime | Result |
| --- | --- | --- |
| JavaScript/Node | Node 24.13.0 | 15 tests passed; strict TypeScript declaration checks passed for portable Fetch, Node and Deno entries. |
| Native Deno | Deno 2.9.7 | Comprehensive native TLS integration test passed. |
| Python | Python 3.14.3 | 81 tests passed, including synchronous and asynchronous clients. |
| Go | Go 1.26.3 | All 11 top-level test groups passed with the race detector; `go vet` and formatting checks passed. |
| Rust | Rust 1.96.0 | 4 unit and 5 transport integration tests passed; Clippy with warnings denied and formatting checks passed. |

Tests cover canonical-origin defaults, opaque credentials, legacy-origin rejection, TLS trust/hostname validation, connection reuse, bounded concurrency and bodies, deadlines/cancellation, bulk response contracts, and absence of automatic POST replay. Exact coverage differs by adapter; inspect the test sources. Constructors perform no implicit warmup or entitlement exchange.

The synthetic TLS fixture generates temporary certificates and verifies their chain before readiness. It uses a loopback-IP certificate to avoid Windows localhost address-fallback delays. Wrong-host and untrusted-certificate tests still reject. No fixture private keys are committed or packaged. Go uses equivalent HTTP/1.1 and HTTP/2 test servers.

## Public release verification

The release branch runs the supported runtime matrix separately from these historical local checks. Registry publication is verified separately; PyPI is deferred pending account review. No regional production latency or end-to-end Supabase signup benchmark is claimed by this release. Native Supabase HTTP hooks do not use an SDK.

Reproduction commands are in [TESTING.md](TESTING.md), API changes in [MIGRATION.md](MIGRATION.md), and official transport references in [RESEARCH.md](RESEARCH.md).
