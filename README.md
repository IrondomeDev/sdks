# IronDome SDKs

Server-side JavaScript/TypeScript, Python, Go and Rust clients for `https://api.irondome.dev`.

Use one opaque `dome_acct_v1.` account key across plan changes. The server applies your current plan. Reuse a client to retain its connection pool. Checks make one API request, with no token exchange or automatic POST retry.

| SDK | Install | Guide |
| --- | --- | --- |
| Node, Fetch, Deno | `npm install @irondome-dev/sdk@0.2.0` | [JavaScript](javascript/README.md) |
| Python 3.11+ | PyPI publication pending; install from [source](python/) | [Python](python/README.md) |
| Go 1.23+ | `go get github.com/IrondomeDev/sdks/go@v0.2.0` | [Go](go/README.md) |
| Rust | `cargo add irondome-sdk@0.2.0` | [Rust](rust/README.md) |

```js
import { IronDome } from '@irondome-dev/sdk/node';
const client = new IronDome({ apiKey: process.env.IRONDOME_API_KEY });
const result = await client.check('person@example.com');
```

Single and bulk checks retain the v1 response contract. Bulk accepts 1-100 emails and preserves order and per-item errors. TLS verification, bounded bodies and deadlines are enabled; redirects are rejected. Credentials belong on your server.

Free accounts share 500 checks per organization per UTC month. Paid accounts bypass the free allowance. Legacy tier-bound keys and the retired free endpoint are unsupported.

See [migration](MIGRATION.md), [testing](TESTING.md), [validation](VALIDATION.md) and [releasing](RELEASING.md).
