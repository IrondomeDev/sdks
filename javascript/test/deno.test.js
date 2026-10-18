import { fileURLToPath } from "node:url";
import { IronDome, APIError, ProtocolError, TimeoutError, TransportError } from "../src/deno.js";

function assert(value, message = "assertion failed") { if (!value) throw new Error(message); }
async function rejects(operation, Type) {
  try { await operation(); } catch (error) { assert(error instanceof Type); return error; }
  throw new Error("expected rejection");
}
Deno.test("Deno native pool: verified TLS reuse, fixed length, no replay, deadlines", async () => {
  const child = new Deno.Command(Deno.build.os === "windows" ? "python" : "python3", {
    args: [fileURLToPath(new URL("../../testing/server.py", import.meta.url))],
    stdin: "piped", stdout: "piped", stderr: "inherit",
  }).spawn();
  let client;
  try {
    const reader = child.stdout.getReader();
    let text = "";
    const decoder = new TextDecoder();
    while (!text.includes("\n")) {
      const { done, value } = await reader.read();
      assert(!done, "fixture exited before readiness");
      text += decoder.decode(value, { stream: true });
    }
    await reader.cancel();
    reader.releaseLock();
    const fixture = JSON.parse(text.trim());
    const ca = await Deno.readTextFile(fixture.ca_file);
    client = new IronDome({ apiKey: "test-key", baseUrl: fixture.url, caCerts: [ca] });
    const health = await client.warmup();
    const first = await client.check("é@example.com");
    const second = await client.check("person@example.com");
    const bulk = await client.checkBulk(["person@example.com", "broken", "person@example.com"]);
    assert(bulk.checked === 2 && bulk.failed === 1 && bulk.results[1].error.code === "invalid_email");
    assert(second.requestId.split("-")[0] === bulk.requestId.split("-")[0]);
    const quota = await rejects(() => client.checkBulk(["quota@example.com"]), APIError);
    assert(quota.status === 429 && quota.code === "monthly_quota_exceeded");
    assert(health.requestId.split("-")[0] === first.requestId.split("-")[0]);
    assert(first.requestId.split("-")[0] === second.requestId.split("-")[0]);
    const error = await rejects(() => client.check("unavailable@example.com"), APIError);
    assert(error.retryAfterSeconds === 5 && error.code === "service_unavailable");
    await rejects(() => client.check("redirect@example.com"), APIError);
    await rejects(() => client.check("oversized@example.com"), ProtocolError);
    // Cancellation may close the reused socket; a deadline can expire during
    // a fresh TLS handshake before the next POST reaches the server.
    const audit = Deno.createHttpClient({ caCerts: [ca] });
    try {
      const before = await (await fetch(fixture.url + "/_stats", { client: audit })).json();
      assert(before.checks_seen === 7, `completed POST was replayed: ${before.checks_seen}`);
    } finally { audit.close(); }
    await rejects(() => client.check("slow-body@example.com", { timeoutMs: 30 }), TimeoutError);
    const untrusted = new IronDome({ apiKey: "test-key", baseUrl: fixture.url });
    try { await rejects(() => untrusted.warmup(), TransportError); } finally { untrusted.close(); }
    const wrongHost = new IronDome({ apiKey: "test-key", baseUrl: fixture.url.replace("127.0.0.1", "localhost"), caCerts: [ca] });
    try { await rejects(() => wrongHost.warmup(), TransportError); } finally { wrongHost.close(); }
    const raw = Deno.createHttpClient({ caCerts: [ca] });
    try {
      const response = await fetch(fixture.url + "/_stats", { client: raw });
      const stats = await response.json();
      assert(stats.checks_seen >= 7 && stats.checks_seen <= 8, `timed-out POST was replayed: ${stats.checks_seen}`);
      assert(stats.health_authorized === false);
    } finally { raw.close(); }
  } finally {
    client?.close();
    await child.stdin.close();
    const status = await child.status;
    assert(status.success, "fixture failed");
  }
});
