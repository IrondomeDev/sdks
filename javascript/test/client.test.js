import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { request } from "node:https";
import { fileURLToPath } from "node:url";
import { IronDome as NodeClient } from "../src/node.js";
import { IronDome, APIError, ValidationError, ConfigurationError, ProtocolError,
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
const options = () => ({ apiKey: "test-key", baseUrl, ca });
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
  for (const opts of [{ ...options(), ca: undefined }, { ...options(), baseUrl: baseUrl.replace("localhost", "127.0.0.1") }]) {
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
