# Migrating SDKs to unified production

SDK 0.2.0 replaces the 0.1 clients. The SDK targets the stable account-key contract at `https://api.irondome.dev`; the stable account-key backend is active in production as of 18 October 2026.

- JavaScript: remove `baseUrl`; it defaults to `https://api.irondome.dev` for Node, Fetch and Deno.
- Python: remove `base_url`; both `Client` and `AsyncClient` default to the canonical origin.
- Go: `New(key, origin, options)` becomes `New(key, options)`. Set `Options.BaseURL` only for trusted staging/tests.
- Rust: see the updated Rust constructor and `Options` in its guide.

`free.irondome.dev` and `irondome-free.edgecompute.app` are rejected as SDK origins, including case/trailing-dot variants. The legacy free endpoint returns HTTP 410. Other trusted HTTPS overrides keep certificate verification and redirect rejection. Never construct a base URL from customer input.

The wire protocol is unchanged: POST `/v1/check`, POST `/v1/check/bulk`, optional GET `/healthz`. Each account uses one opaque `dome_acct_v1.` key across plan changes. The server applies the current account plan: free accounts share 500 checks per month, while paid accounts bypass that quota. The SDK passes the key unchanged, exposes HTTP 429 and does not retry it. Existing tier-bound `dome_free_v1.` and `dome_live_v1.` keys are rejected; obtain a new account key. A plan change does not require key replacement or a new client. When the credential itself is replaced, create a new client and drain the old one.

Keep old clients alive until their work drains when replacing credentials. Supabase native HTTP hooks use installation URLs and HMAC secrets configured by the control plane; they do not require this SDK in the hook path. Applications using the SDK inside a Supabase Edge Function use the portable Fetch entry.

Language-specific release workflows verify package versions and tagged commits. Python registry publication is deferred pending account review.
