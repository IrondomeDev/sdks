# Releasing SDKs

The public source is `IrondomeDev/sdks`. Version 0.2.0 migrates to the unified account-key API. Python source is included, but PyPI publication is deferred pending account review.

1. Run the fixture-only runtime matrix in `ci.yml`. These tests do not call production or consume D1 quota.
2. Review package archives, metadata, licensing and migration notes. Match each package version to its language tag.
3. Merge the tested commit, then create `javascript/v0.2.0`, `rust/v0.2.0` and `go/v0.2.0`. Create `python/v0.2.0` only when PyPI is ready.
4. Run `RELEASE_TAG=<tag> node scripts/check-release.mjs <language>` on the tagged commit.
5. Publish npm and crates from the verified checkout or enable their trusted publishing workflows after configuring registry trust. Verify registry metadata after publishing. The Go subdirectory tag is its release; verify it through the Go module proxy.

Registry workflows are disabled unless their repository variable (`NPM_RELEASE_ENABLED`, `CRATES_RELEASE_ENABLED`, `PYPI_RELEASE_ENABLED`) is `true`. Configure the matching GitHub environment (`npm`, `crates`, `pypi`) and registry trusted publisher before enabling a workflow. Keep registry credentials out of source and logs. Build jobs do not receive publication permissions.

For PyPI, the pending publisher is project `irondome-sdk`, owner `IrondomeDev`, repository `sdks`, workflow `publish-pypi.yml`, environment `pypi`. Do not enable it during account review.

Published versions are immutable. Fix a faulty release with a new version; use registry deprecation/yanking where appropriate rather than replacing its contents.

Official references: [npm publishing](https://docs.npmjs.com/cli/commands/npm-publish/), [npm trusted publishers](https://docs.npmjs.com/trusted-publishers/), [Cargo publishing](https://doc.rust-lang.org/cargo/commands/cargo-publish.html), [Go module releases](https://go.dev/doc/modules/managing-source), [PyPI trusted publishing](https://docs.pypi.org/trusted-publishers/).
