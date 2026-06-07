/**
 * perplexity-visibility-checker — Cloudflare Worker
 * ----------------------------------------------------------------------------
 * A thin, stateless proxy in front of Bright Data's "Perplexity Search" scraper
 * (dataset gd_m7dhdot1vw9a7gc1n).
 *
 * Why a proxy? Bright Data's API sends no CORS headers, so a browser can't call
 * it directly. This Worker forwards the request server-side, on the same origin.
 *
 * Bring Your Own Key (BYOK): the visitor pastes THEIR OWN Bright Data token in
 * the UI. It is sent as `Authorization: Bearer <token>`, forwarded to Bright
 * Data, and never persisted by this Worker (no KV, no logging of the token).
 *
 * Abuse protection: POST /api/check is rate-limited per client IP (CHECK_RL).
 */

const DATASET_ID = "gd_m7dhdot1vw9a7gc1n"; // Perplexity Search - search by prompt
const BD_BASE = "https://api.brightdata.com";
const triggerUrl = (id) =>
  `${BD_BASE}/datasets/v3/trigger?dataset_id=${id}&notify=false&include_errors=true`;
const progressUrl = (sid) => `${BD_BASE}/datasets/v3/progress/${sid}`;
const snapshotUrl = (sid) => `${BD_BASE}/datasets/v3/snapshot/${sid}?format=json`;
const SNAPSHOT_RE = /^s[dn]_[a-z0-9]+$/i;

// Same-origin only: the page and /api are served by THIS same Worker, so we emit
// no cross-origin (CORS) headers — other websites can't drive these endpoints with
// a visitor's token.
const corsHeaders = (extra = {}) => ({ ...extra });

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...corsHeaders(), ...extra },
  });

function getToken(request) {
  const m = (request.headers.get("Authorization") || "").match(/^Bearer\s+(.+)$/i);
  const token = m ? m[1].trim() : "";
  return token.length >= 8 ? token : null;
}

function humanError(data, text, status) {
  if (status === 401 || /token expired|unauthorized/i.test(text))
    return "Your Bright Data token was rejected (expired or invalid). Check it and try again.";
  if (data && typeof data.error === "string") return data.error;
  if (Array.isArray(data?.errors) && data.errors.length)
    return data.errors.map((e) => (Array.isArray(e) ? e.join(": ") : String(e))).join("; ");
  return text?.slice(0, 300) || `Bright Data error (HTTP ${status}).`;
}

async function rl(env, request, binding) {
  try {
    const b = env && env[binding];
    if (b && typeof b.limit === "function") {
      const ip = request.headers.get("CF-Connecting-IP") || "anon";
      const { success } = await b.limit({ key: ip });
      return !success;
    }
  } catch {
    /* fail open */
  }
  return false;
}

async function handleCheck(request, env) {
  const token = getToken(request);
  if (!token) return json({ error: "Missing Bright Data API token." }, 401);

  if (await rl(env, request, "CHECK_RL")) {
    return json(
      { error: "Too many checks from your network. Please wait a minute and try again." },
      429,
      { "Retry-After": "60" }
    );
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid request body." }, 400); }

  const prompt = String(body.prompt || "").trim();
  const brand = String(body.brand || "").trim();
  const country = String(body.country || "").trim().toUpperCase().slice(0, 2);

  if (!prompt) return json({ error: "Please enter a buyer question to ask Perplexity." }, 400);
  if (prompt.length > 500) return json({ error: "Question is too long (max 500 characters)." }, 400);
  if (brand.length > 120) return json({ error: "Brand name is too long." }, 400);

  const input = {
    url: "https://www.perplexity.ai",
    prompt,
    country: /^[A-Z]{2}$/.test(country) ? country : "US",
    index: 1,
  };

  // Async: trigger the job and return a snapshot_id immediately (no held connection),
  // then the client polls /api/status + /api/result. This avoids edge/connection timeouts.
  try {
    const r = await fetch(triggerUrl(DATASET_ID), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ input: [input] }),
    });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!r.ok) return json({ error: humanError(data, text, r.status) }, r.status);
    if (!data || !data.snapshot_id) return json({ error: "Bright Data did not return a snapshot id." }, 502);
    return json({ ok: true, brand, prompt, country: input.country, done: false, snapshot_id: data.snapshot_id });
  } catch (e) {
    return json({ error: e?.message || "Failed to reach Bright Data." }, 502);
  }
}

async function passthrough(request, url, kind, env) {
  const token = getToken(request);
  if (!token) return json({ error: "Missing Bright Data API token." }, 401);
  if (await rl(env, request, "POLL_RL")) return json({ error: "Too many requests — please slow down." }, 429, { "Retry-After": "30" });
  const id = url.searchParams.get("id") || "";
  if (!SNAPSHOT_RE.test(id)) return json({ error: "Invalid snapshot id." }, 400);
  const target = kind === "status" ? progressUrl(id) : snapshotUrl(id);
  try {
    const r = await fetch(target, { headers: { Authorization: `Bearer ${token}` } });
    const text = await r.text();
    if (kind === "status") {
      let data; try { data = JSON.parse(text); } catch { data = { status: "unknown", raw: text }; }
      return json(data, r.ok ? 200 : r.status);
    }
    return new Response(text, {
      status: r.ok ? 200 : r.status,
      headers: { "content-type": "application/json; charset=utf-8", ...corsHeaders() },
    });
  } catch (e) {
    return json({ error: e?.message || "Upstream request failed.", status: "unknown" }, kind === "status" ? 200 : 502);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS" && url.pathname.startsWith("/api/"))
      return new Response(null, { status: 204, headers: corsHeaders() });
    if (url.pathname === "/api/health") return json({ ok: true });
    if (url.pathname === "/api/check" && request.method === "POST") return handleCheck(request, env);
    if (url.pathname === "/api/status" && request.method === "GET") return passthrough(request, url, "status", env);
    if (url.pathname === "/api/result" && request.method === "GET") return passthrough(request, url, "result", env);
    if (url.pathname.startsWith("/api/")) return json({ error: "Not found." }, 404);
    return env.ASSETS.fetch(request);
  },
};
