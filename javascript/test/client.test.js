import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { request } from "node:https";
import { fileURLToPath } from "node:url";
import { IronDome as NodeClient } from "../src/node.js";
import { IronDome, DEFAULT_BASE_URL, APIError, ValidationError, ConfigurationError, ProtocolError,
  TimeoutError, CancelledError, BusyError, ClosedError, TransportError } from "../src/index.js";

let fixture, baseUrl, ca;
before(async () => {
  const python = process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");
  const server = fileURLToPath(new URL("../../testing/server.py", import.meta.url));
  fixture = spawn(python, [server], { stdio: ["pipe", "pipe", "inherit"] });
  const lines = createInterface({ input: fixture.stdout });
  const [line] = await once(lines, "line");
  ({ url: baseUrl } = JSON.parse(line));
  ca = readFileSync(JSON.parse(line).ca_file);
  lines.close();
});
after(async () => { fixture.stdin.end(); await once(fixture, "exit"); });
// Functional pool assertions tolerate slow first TLS initialization; dedicated
// deadline cases below still supply their short explicit budgets.
const options = () => ({ apiKey: "test-key", baseUrl, ca, timeoutMs: 30000 });
const valid = () => ({ provider: "custom", valid: true, disposable: false, reason: "not_listed" });
const json = (value, init = {}) => new Response(JSON.stringify(value), {
  ...init, headers: { "content-type": "application/json", ...init.headers },
});
function stats() {
  return new Promise((resolve, reject) => {
    request(baseUrl + "/_stats", { ca, agent: false }, (response) => {
      let text = "";
      response.on("data", (data) => { text += data; });
      response.on("end", () => resolve(JSON.parse(text)));
    }).on("error", reject).end();
  });
}

test("Node reuses a verified TLS socket across health and sequential checks", async () => {
  const client = new NodeClient(options());
  try {
    const health = await client.warmup();
    const first = await client.check("person@example.com");
    const second = await client.check("é@example.com");
    assert.equal(health.requestId.split("-")[0], first.requestId.split("-")[0]);
    assert.equal(first.requestId.split("-")[0], second.requestId.split("-")[0]);
    assert.equal(second.reason, "not_listed");
    assert.equal((await stats()).health_authorized, false);
    assert.ok(!JSON.stringify(client).includes("test-key"));
  } finally { client.close(); }
});

test("Node rejects untrusted certificates and hostname mismatches", async () => {
  for (const opts of [{ ...options(), ca: undefined }, { ...options(), baseUrl: baseUrl.replace("127.0.0.1", "localhost") }]) {
    const client = new NodeClient(opts);
    try { await assert.rejects(client.warmup(), TransportError); } finally { client.close(); }
  }
});

test("Node sends one check on redirects, HTTP errors, and ambiguous disconnects", async () => {
  const client = new NodeClient(options());
  try {
    for (const email of ["redirect", "unavailable", "truncated"]) {
      const before = await stats();
      await assert.rejects(client.check(email + "@example.com"));
      assert.equal((await stats()).checks_seen, before.checks_seen + 1);
    }
    await assert.rejects(client.check("unavailable@example.com"), (error) => {
      assert.ok(error instanceof APIError);
      assert.equal(error.status, 503);
      assert.equal(error.code, "service_unavailable");
      assert.equal(error.retryAfterSeconds, 5);
      assert.ok(!String(error).includes("private"));
      return true;
    });
    await client.check("cookie@example.com");
    await client.check("person@example.com");
    assert.equal((await stats()).cookies_seen, false);
  } finally { client.close(); }
});

test("Node bounds bodies and rejects malformed success payloads", async () => {
  const client = new NodeClient(options());
  try {
    for (const email of ["oversized", "chunked-oversized", "malformed", "invalid-schema"]) {
      await assert.rejects(client.check(email + "@example.com"), ProtocolError);
    }
    await assert.rejects(client.check("html@example.com"), (error) => error instanceof APIError && error.code === "http_error");
  } finally { client.close(); }
});

test("Node deadlines cover headers, body, and queued requests", async () => {
  const client = new NodeClient({ ...options(), maxSockets: 1 });
  try {
    for (const email of ["slow", "slow-body"]) {
      await assert.rejects(client.check(email + "@example.com", { timeoutMs: 30 }), TimeoutError);
    }
    const slow = client.check("slow@example.com");
    await assert.rejects(client.check("person@example.com", { timeoutMs: 30 }), TimeoutError);
    await slow;
    const controller = new AbortController();
    controller.abort("private");
    await assert.rejects(client.check("person@example.com", { signal: controller.signal }), CancelledError);
  } finally { client.close(); }
  await assert.rejects(client.warmup(), ClosedError);
});

test("Fetch uses an immutable fixed-length body and never authenticates warmup", async () => {
  const calls = [];
  const client = new IronDome({ apiKey: "test-key", baseUrl, fetch: async (url, init) => {
    calls.push({ url, init });
    return json(init.method === "GET" ? { status: "ok" } : valid());
  } });
  await client.warmup();
  await client.check("é@example.com");
  assert.equal(calls[0].init.headers.authorization, undefined);
  assert.equal(calls[1].init.headers.authorization, "Bearer test-key");
  assert.equal(calls[1].init.redirect, "manual");
  assert.equal(calls[1].init.credentials, "omit");
  assert.equal(calls[1].init.cache, "no-store");
  assert.ok(calls[1].init.body instanceof Uint8Array);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(calls[1].init.body)), { email: "é@example.com" });
  assert.equal(calls[1].init.headers["content-length"], undefined);
  client.close();
});

test("configuration and request-size rejection happen without I/O", async () => {
  for (const baseUrl of ["http://example.com", "https://u:p@example.com", "https://example.com/path", "https://example.com/x/..", "https://example.com:0", "https://example.com?", "https://example.com#", "https://example.com\\evil", " https://example.com"]) {
    assert.throws(() => new IronDome({ apiKey: "test", baseUrl }), ConfigurationError);
  }
  for (const apiKey of ["", "has space", "x\r\ny", "é", "x".repeat(4097)]) {
    assert.throws(() => new IronDome({ apiKey, baseUrl }), ConfigurationError);
  }
  for (const timeoutMs of [0, -1, NaN, Infinity, 2147483648]) {
    assert.throws(() => new IronDome({ apiKey: "test", baseUrl, timeoutMs }), ConfigurationError);
  }
  let count = 0;
  const client = new IronDome({ apiKey: "test", baseUrl, fetch: async () => { count++; return json(valid()); } });
  for (const email of [42, "x".repeat(1013), "é".repeat(507), "\ud800"]) {
    await assert.rejects(client.check(email), ValidationError);
  }
  assert.equal(count, 0);
  await client.check("x".repeat(1012));
  assert.equal(count, 1);
});

test("Fetch enforces deadlines through the body and cancels oversized streams", async () => {
  let cancelled = false;
  const client = new IronDome({ apiKey: "test", baseUrl, fetch: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(16385)); },
    cancel() { cancelled = true; },
  }), { headers: { "content-type": "application/json" } }) });
  await assert.rejects(client.warmup(), ProtocolError);
  assert.equal(cancelled, true);
  const slow = new IronDome({ apiKey: "test", baseUrl, maxInFlight: 1, fetch: async (_, init) => {
    return new Response(new ReadableStream({ start(controller) {
      init.signal.addEventListener("abort", () => controller.error(new Error("private")), { once: true });
    } }), { headers: { "content-type": "application/json" } });
  } });
  const pending = slow.warmup({ timeoutMs: 20 });
  await assert.rejects(slow.warmup(), BusyError);
  await assert.rejects(pending, TimeoutError);
  assert.equal(cancelled, true);
});

test("Fetch sanitizes error payloads and validates booleans and enums", async () => {
  for (const body of [{ ...valid(), valid: 1 }, { ...valid(), disposable: "false" }, { ...valid(), reason: "unknown" }, { ...valid(), provider: "unknown" }]) {
    const client = new IronDome({ apiKey: "test", baseUrl, fetch: async () => json(body) });
    await assert.rejects(client.check("person@example.com"), ProtocolError);
  }
  const client = new IronDome({ apiKey: "test", baseUrl, fetch: async () => json({ error: { code: "private", message: "private" } }, { status: 500 }) });
  await assert.rejects(client.warmup(), (error) => error instanceof APIError && error.code === "http_error" && !String(error).includes("private"));
});

test("Node bulk preserves order, duplicates, mixed errors and the warm socket", async () => {
  const client = new NodeClient(options());
  try {
    const health = await client.warmup();
    const result = await client.checkBulk(["person@example.com", "broken", "person@example.com", ""]);
    assert.equal(health.requestId.split("-")[0], result.requestId.split("-")[0]);
    assert.equal(result.checked, 2); assert.equal(result.failed, 2);
    assert.deepEqual(result.results.map(item => item.index), [0, 1, 2, 3]);
    assert.equal(result.results[1].error.code, "invalid_email");
    assert.ok(!JSON.stringify(result).includes("private"));
    assert.ok(!JSON.stringify(result).includes("@"));
    assert.ok(Object.isFrozen(result.results));
    assert.equal((await client.checkBulk(Array(100).fill("person@example.com"))).checked, 100);
    assert.equal((await client.checkBulk(["broken", ""])).checked, 0);
    assert.equal((await client.checkBulk(["padded@example.com"])).checked, 1);
  } finally { client.close(); }
});

test("bulk validation rejects invalid types, Unicode and byte bounds before I/O", async () => {
  let calls = 0;
  const client = new IronDome({ ...options(), fetch: async () => { calls++; return json({results:[{index:0,...valid()}],checked:1,failed:0}); } });
  for (const emails of [null, "x", [], Array(101).fill("x"), [2], ["\ud800"], ["x".repeat(65523)], ["é".repeat(32762)]]) {
    await assert.rejects(client.checkBulk(emails), ValidationError);
  }
  assert.equal(calls, 0);
  await client.checkBulk(["x".repeat(65521)]);
  assert.equal(calls, 1);
  client.close();
});

test("bulk quota errors and ambiguous failures never trigger POST replay", async () => {
  const client = new NodeClient(options());
  try {
    for (const mode of ["quota", "redirect", "unavailable", "truncated"]) {
      const before = await stats();
      await assert.rejects(client.checkBulk([`${mode}@example.com`]), error => {
        if (mode === "quota") assert.ok(error instanceof APIError && error.status === 429 && error.code === "monthly_quota_exceeded");
        return true;
      });
      assert.equal((await stats()).checks_seen, before.checks_seen + 1);
    }
    for (const mode of ["bulk-invalid-index", "bulk-invalid-count", "bulk-invalid-error", "oversized", "chunked-oversized"]) {
      await assert.rejects(client.checkBulk([`${mode}@example.com`]), ProtocolError);
    }
    await assert.rejects(client.checkBulk(["slow@example.com"], {timeoutMs:30}), TimeoutError);
    const signal = AbortSignal.abort("private");
    await assert.rejects(client.checkBulk(["a@example.com"], {signal}), CancelledError);
  } finally {client.close();}
  await assert.rejects(client.checkBulk(["a@example.com"]), ClosedError);
});

test("Fetch bulk rejects wrong indexes, counts, missing or ambiguous item fields", async () => {
  const good = {results:[{index:0,...valid()}],checked:1,failed:0};
  for (const value of [
    {...good,checked:true}, {...good,failed:-1}, {...good,results:[]},
    {...good,results:[{index:1,...valid()}]}, {...good,results:[{index:0,...valid(),error:{code:"invalid_email"}}]},
    {...good,results:[{index:0,...valid(),valid:1}]},
    {results:[{index:0,error:{code:"private"}}],checked:0,failed:1},
  ]) {
    const client = new IronDome({...options(),fetch:async()=>json(value)});
    await assert.rejects(client.checkBulk(["a@example.com"]), ProtocolError);
    client.close();
  }
  for (const code of ["empty_batch", "batch_too_large", "monthly_quota_exceeded"]) {
    const client = new IronDome({...options(),fetch:async()=>json({error:{code,message:"private"}},{status:429})});
    await assert.rejects(client.checkBulk(["a@example.com"]), error=>error instanceof APIError && error.code===code && !String(error).includes("private"));
    client.close();
  }
});

test("unified production is the default for opaque free and paid keys without an extra request", async () => {
  assert.equal(DEFAULT_BASE_URL, "https://api.irondome.dev");
  for (const apiKey of ["dome_free_v1.synthetic", "dome_live_v1.synthetic"]) {
    const seen = [];
    const client = new IronDome({ apiKey, fetch: async (url, init) => {
      seen.push({ url, method: init.method });
      assert.equal(init.headers.authorization, `Bearer ${apiKey}`);
      return json(valid());
    } });
    assert.equal(seen.length, 0);
    await client.check("person@example.com");
    assert.deepEqual(seen, [{ url: DEFAULT_BASE_URL + "/v1/check", method: "POST" }]);
    client.close();
  }
});
test("legacy free endpoints fail before network access in Fetch and Node clients", () => {
  for (const baseUrl of ["https://free.irondome.dev", "https://FREE.IRONDOME.DEV./", "https://irondome-free.edgecompute.app"]) {
    for (const Client of [IronDome, NodeClient]) assert.throws(() => new Client({ apiKey: "test", baseUrl }), ConfigurationError);
  }
});
