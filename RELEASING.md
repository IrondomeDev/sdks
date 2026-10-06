# SDK releases

## Source and ownership

`IrondomeDev/sdks` is the SDK source of truth. JavaScript, Python, Go, and Rust
share one repository and local TLS fixtures, but have independent versions.
The Fastly backend and web app remain separate repositories. The old
`client_sdk` folder in the Fastly repository is a historical source snapshot;
SDK development should happen here.

The repository starts private while release preparation is underway. MIT was
selected by the owner. Make the source public before advertising public
installation commands or releasing registry packages.

## Distribution

| Language | Registry | Proposed package/module | Release tag |
| --- | --- | --- | --- |
| JavaScript / TypeScript | npm | `@irondome/sdk` | `javascript/v0.1.0` |
| Python | PyPI | `irondome-sdk` (import `irondome`) | `python/v0.1.0` |
| Rust | crates.io | `irondome-sdk` | `rust/v0.1.0` |
| Go | Public GitHub module, indexed by Go tooling | `github.com/IrondomeDev/sdks/go` | `go/v0.1.0` |

Names are proposals, not reservations or availability claims. Confirm ownership
and availability on each registry before enabling publication. An npm scope is
independent of a GitHub organization: `IrondomeDev` does not grant `@irondome`.
The Node, portable Fetch, and Deno entry points remain in the same JavaScript
package. A separate JSR release can be considered later if consumers need it.

Go uses a subdirectory-prefixed version tag because its `go.mod` lives in `go/`.
It needs no npm/PyPI-style upload. After making the repository public and tagging
a verified version, request that version through Go tooling to index it.

## Before the first release

1. Add `checkBulk` / equivalent helpers to every supported client and runtime,
   with ordered typed results, 1–100 string validation, a 65,536-byte body bound,
   and a response bound large enough for 100 results.
2. Recognize quota and bulk error codes. Current strict error allowlists predate
   `monthly_quota_exceeded`, `empty_batch`, and `batch_too_large`.
3. Test single/bulk classification parity, mixed-invalid items, free quota,
   expiry/scope/auth errors, cancellation, response limits, and no automatic
   replay. Retain connection pooling and explicit unbilled warmup.
4. Run the CI matrix and owned live smoke checks on both API domains. Package
   builds and installed-package checks must confirm types, license, import paths,
   and runtime dependencies. Do not infer hosted-runtime behavior from mocks.
5. Update examples to registry installation commands after the actual release.
   Document both endpoints, per-email usage, and lost-response retry uncertainty.
6. Inspect the npm tarball, Python wheel/sdist, and Rust crate. Include SDK code,
   type information, documentation, and MIT license; exclude credentials, backend
   implementation, experiments, test-generated certificates, and build caches.
7. Add release notes and language-specific tags only after the matching package
   metadata version and immutable commit have been verified.

No registry credentials, publishing workflow, tag, or published package has been
created by this repository setup. `private:true` and `publish:false` remain
explicit release gates in JavaScript and Rust.

## Registry account setup

### npm

Create or use a maintainer account with two-factor authentication and an npm
organization owning the chosen scope. Bootstrap the first scoped public package
through the authorized account. Then configure a trusted publisher for
`IrondomeDev/sdks` and the exact release workflow/environment. Use GitHub-hosted
Actions with OIDC and provenance rather than a stored long-lived publishing token.
Trusted publishing currently requires Node >=22.14 and npm >=11.5.1.

### PyPI

Create or use the owner account. Register a pending trusted publisher for the
chosen project name, repository owner `IrondomeDev`, repository `sdks`, and the
exact future workflow filename/environment. PyPI can create the project on its
first authorized publish. Use TestPyPI separately for release rehearsal.

### crates.io

Sign in with the maintainer's GitHub account and perform the first authorized
crate publication. Then configure the crate's trusted publisher for the exact
GitHub workflow. Use short-lived CI credentials for subsequent versions. Confirm
crate ownership and organization maintenance access on the registry.

## Release workflow design

Use separate `publish-npm.yml`, `publish-pypi.yml`, and `publish-crates.yml` files,
each tied to its own language tags and exact registry trust configuration. A
release builds the tagged commit, verifies version consistency and package
contents, runs its checks, and uploads only that package. Use minimal permissions,
pinned Actions, and `id-token:write` only in the publishing job. PR tests have no
publishing credentials. Main-branch pushes do not publish packages.

## Official references

- [npm scoped public packages](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/)
- [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
- [PyPI trusted publishing](https://docs.pypi.org/trusted-publishers/)
- [crates.io trusted publishing](https://crates.io/docs/trusted-publishing)
- [Go module publication](https://go.dev/doc/modules/publishing)
- [Go module version tags](https://go.dev/ref/mod#vcs-version)
