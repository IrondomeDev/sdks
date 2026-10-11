# IronDome SDKs

[![npm](https://img.shields.io/npm/v/%40irondome-dev%2Fsdk?label=npm&color=F76808)](https://www.npmjs.com/package/@irondome-dev/sdk)
[![crates.io](https://img.shields.io/crates/v/irondome-sdk?label=crates.io&color=F76808)](https://crates.io/crates/irondome-sdk)
[![MIT license](https://img.shields.io/badge/license-MIT-F76808)](LICENSE)
[![Documentation](https://img.shields.io/badge/read-documentation-F76808)](https://irondome.dev/docs)

Official open-source SDKs for [IronDome](https://irondome.dev), the fastest and most accurate disposable email detection API for signup forms and backend applications. Check temporary email domains and known disposable addresses, including aliases on supported email providers.

The free plan includes **500 checks per month**. Get an API key from the [dashboard](https://app.irondome.dev/) and follow the [quickstart](https://irondome.dev/docs/quickstart).

## Install

### JavaScript and TypeScript

```sh
npm install @irondome-dev/sdk@0.1.0
```

```js
import { IronDome } from '@irondome-dev/sdk/node';

// Reuse this client across requests in your server process.
const client = new IronDome({
  apiKey: process.env.IRONDOME_API_KEY,
  baseUrl: 'https://free.irondome.dev',
});

const result = await client.check('person@example.com');
console.log(result.disposable);
```

Node.js 22+ uses the `/node` entry. Use `@irondome-dev/sdk` for portable Fetch environments, including Cloudflare Workers and Supabase Edge Functions. Standalone Deno also has a dedicated `/deno` adapter. [JavaScript guide](javascript/README.md) ? [Serverless integrations](https://irondome.dev/docs/guides/edge-serverless).

### Rust

```sh
cargo add irondome-sdk@0.1.0
```

An asynchronous reqwest/rustls client with a shared connection pool. [Rust guide and example](rust/README.md) ? [API documentation](https://docs.rs/irondome-sdk).

### All SDKs

| Language or runtime | Package status | Guide |
| --- | --- | --- |
| JavaScript / TypeScript | [npm: @irondome-dev/sdk](https://www.npmjs.com/package/@irondome-dev/sdk) | [Node.js, Fetch and Deno](javascript/README.md) |
| Rust | [crates.io: irondome-sdk](https://crates.io/crates/irondome-sdk) | [Rust](rust/README.md) |
| Python 3.11+ | Source available; PyPI publication pending | [Python](python/README.md) |
| Go 1.23+ | Source available; versioned module release pending | [Go](go/README.md) |

## Single and bulk email checks

JavaScript and Rust 0.1.0 support single checks, bulk requests of up to 100 emails, and optional health warmup. Bulk results preserve input order and include invalid-address errors per item.

```js
const batch = await client.checkBulk(['person@example.com', 'invalid']);
for (const item of batch.results) {
  if ('error' in item) console.log(item.index, item.error.code);
  else console.log(item.index, item.disposable);
}
```

Each syntactically valid email in a bulk request counts as one check. See the [bulk API reference](https://irondome.dev/docs/api/bulk) for limits and response details.

## Plans and API keys

| Plan | Base URL | API key |
| --- | --- | --- |
| Free | `https://free.irondome.dev` | Free key |
| Pay as you go | `https://api.irondome.dev` | Paid key |

When switching plans, change **both the endpoint and API key**. Keep credentials on the server, outside browser bundles and logs. Configure keys through environment variables or your secret store. [Plans and endpoints](https://irondome.dev/docs/plans).

## Performance and error handling

Reuse clients that own connection pools. Rust clones share a pool; Python async clients belong to one event loop. Portable Fetch clients use the platform's network management; follow the runtime guide for their lifecycle.

Optional `warmup()` sends `GET /healthz` without consuming an email check. It can prepare a connection for later reuse, but cannot guarantee the same edge instance or eliminate cold starts. Avoid adding a warmup round trip before every check.

SDKs do not cache classifications or automatically retry checks. A timeout may occur after the server has processed a request; handle errors separately from an allowed email result. `valid` does not establish mailbox existence or deliverability, and `not_listed` means the address was not found in the current lists.

[Performance guide](https://irondome.dev/docs/guides/performance) ? [Published benchmarks](https://irondome.dev/benchmarks) ? [Errors](https://irondome.dev/docs/errors).

## Contributing

Issues and pull requests are welcome. Include the SDK, runtime version, expected behavior and a minimal example. Remove API keys and personal email addresses before sharing logs.

See [TESTING.md](TESTING.md) for local fixtures, commands and measurement boundaries. Keep SDK changes scoped to their language folder and preserve the shared [API contract](https://irondome.dev/docs/api/check).

## License

[MIT](LICENSE). Maintained by [IrondomeDev](https://github.com/IrondomeDev).
