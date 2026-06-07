// Integration tests for the Worker (src/worker.js).
// We import the real module and drive it with WHATWG Request/env objects,
// stubbing global fetch so no network call ever leaves the machine.
// Run with: npm test  (node --test, zero dependencies).

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import worker from "../src/worker.js";

const ORIGIN = "https://example.workers.dev";
const TOKEN = "tok_12345678"; // >= 8 chars so getToken() accepts it
const SNAP = "sd_abc123";

// A minimal env: ASSETS for the catch-all, no rate-limit bindings (so rl() fails open).
const baseEnv = () => ({
  ASSETS: { fetch: async () => new Response("<!doctype html>", { status: 200, headers: { "content-type": "text/html" } }) },
});

function req(path, { method = "GET", token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = "Bearer " + token;
  const init = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  return new Request(ORIGIN + path, init);
}

let calls;
const realFetch = globalThis.fetch;
beforeEach(() => { calls = []; });
afterEach(() => { globalThis.fetch = realFetch; });

// Program global fetch to record calls and reply with the given Response.
function stubFetch(handler) {
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    return handler(String(url), opts);
  };
}

test("GET /api/health returns 200 ok", async () => {
  const res = await worker.fetch(req("/api/health"), baseEnv());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test("responses carry no CORS allow-origin header (same-origin design)", async () => {
  const res = await worker.fetch(req("/api/health"), baseEnv());
  assert.equal(res.headers.get("access-control-allow-origin"), null);
});

test("OPTIONS /api/check preflight returns 204", async () => {
  const res = await worker.fetch(req("/api/check", { method: "OPTIONS" }), baseEnv());
  assert.equal(res.status, 204);
});

test("POST /api/check without a token returns 401", async () => {
  const res = await worker.fetch(req("/api/check", { method: "POST", body: { prompt: "x" } }), baseEnv());
  assert.equal(res.status, 401);
  assert.match((await res.json()).error, /token/i);
});

test("POST /api/check with empty prompt returns 400", async () => {
  const res = await worker.fetch(req("/api/check", { method: "POST", token: TOKEN, body: { prompt: "  " } }), baseEnv());
  assert.equal(res.status, 400);
});

test("POST /api/check with an over-long prompt returns 400", async () => {
  const res = await worker.fetch(
    req("/api/check", { method: "POST", token: TOKEN, body: { prompt: "x".repeat(501) } }),
    baseEnv()
  );
  assert.equal(res.status, 400);
});

test("POST /api/check triggers Bright Data and returns a snapshot_id", async () => {
  stubFetch(() => new Response(JSON.stringify({ snapshot_id: SNAP }), { status: 200 }));
  const res = await worker.fetch(
    req("/api/check", { method: "POST", token: TOKEN, body: { prompt: "best CRM", brand: "roaspig" } }),
    baseEnv()
  );
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.done, false);
  assert.equal(data.snapshot_id, SNAP);
  assert.equal(data.brand, "roaspig");
  assert.equal(data.country, "US"); // defaults to US when none supplied
  // Verify it actually hit the trigger endpoint with the token and a JSON body.
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/datasets\/v3\/trigger\?/);
  assert.equal(calls[0].opts.headers.Authorization, "Bearer " + TOKEN);
  const sent = JSON.parse(calls[0].opts.body);
  assert.equal(sent.input[0].prompt, "best CRM");
  assert.equal(sent.input[0].country, "US"); // Perplexity defaults to US
  assert.equal(sent.input[0].index, 1);
});

test("POST /api/check normalizes a supplied country code to upper-case ISO-2", async () => {
  stubFetch(() => new Response(JSON.stringify({ snapshot_id: SNAP }), { status: 200 }));
  const res = await worker.fetch(
    req("/api/check", { method: "POST", token: TOKEN, body: { prompt: "best CRM", country: "gb" } }),
    baseEnv()
  );
  assert.equal(res.status, 200);
  const sent = JSON.parse(calls[0].opts.body);
  assert.equal(sent.input[0].country, "GB");
});

test("POST /api/check surfaces a friendly message when the token is rejected", async () => {
  stubFetch(() => new Response(JSON.stringify({ error: "token expired" }), { status: 401 }));
  const res = await worker.fetch(
    req("/api/check", { method: "POST", token: TOKEN, body: { prompt: "best CRM" } }),
    baseEnv()
  );
  assert.equal(res.status, 401);
  assert.match((await res.json()).error, /rejected|expired|invalid/i);
});

test("POST /api/check is blocked by the rate limiter (429)", async () => {
  const env = { ...baseEnv(), CHECK_RL: { limit: async () => ({ success: false }) } };
  const res = await worker.fetch(
    req("/api/check", { method: "POST", token: TOKEN, body: { prompt: "best CRM" } }),
    env
  );
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("Retry-After"), "60");
});

test("GET /api/status rejects a malformed snapshot id (400)", async () => {
  const res = await worker.fetch(req("/api/status?id=not-a-real-id", { token: TOKEN }), baseEnv());
  assert.equal(res.status, 400);
});

test("GET /api/status passes through Bright Data progress", async () => {
  stubFetch(() => new Response(JSON.stringify({ status: "running" }), { status: 200 }));
  const res = await worker.fetch(req(`/api/status?id=${SNAP}`, { token: TOKEN }), baseEnv());
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, "running");
  assert.match(calls[0].url, /\/datasets\/v3\/progress\//);
});

test("GET /api/result passes through the snapshot JSON", async () => {
  stubFetch(() => new Response(JSON.stringify([{ answer_text: "hi" }]), { status: 200 }));
  const res = await worker.fetch(req(`/api/result?id=${SNAP}`, { token: TOKEN }), baseEnv());
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /application\/json/);
  assert.match(calls[0].url, /\/datasets\/v3\/snapshot\//);
});

test("unknown /api/* path returns 404", async () => {
  const res = await worker.fetch(req("/api/nope"), baseEnv());
  assert.equal(res.status, 404);
});

test("non-/api/ path is served by the ASSETS binding", async () => {
  const res = await worker.fetch(req("/"), baseEnv());
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);
});
