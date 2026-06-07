# 🔮 perplexity-visibility-checker

**See whether Perplexity cites your brand — live.**

Perplexity answers every question with a ranked list of **sources**. That list
*is* the game: if your domain isn't on it, you don't exist at the moment your
buyer is deciding.

Type your brand and a buyer question. This tool runs your question through
Perplexity live (via Bright Data's Perplexity dataset) and tells you whether you were:

- **Cited** as a source (and at what rank),
- **Named** in the answer text, or
- **Invisible** — with the exact ranked sources Perplexity trusts instead.

> Part of a 3-tool series on AI brand visibility. See also the
> [ChatGPT checker](https://github.com/yaronbeen/chatgpt-visibility-checker)
> and the combined [invisible-to-ai](https://github.com/yaronbeen/invisible-to-ai).
>
> Inspired by *["My SaaS Was Invisible to ChatGPT"](https://medium.com/@yaron.been/my-saas-was-invisible-to-chatgpt-i-built-a-scraping-pipeline-to-fix-it-4703bbed2345)*.

---

## How it works

```
Browser ──► Cloudflare Worker (same-origin proxy) ──► Bright Data Perplexity scraper
   ▲                                                          │
   └──────────  answer + ranked sources + verdict  ◄──────────┘
```

1. You enter a **brand**, a **buyer question**, a **location**, and **your own
   Bright Data token**.
2. The Worker calls the Perplexity scraper (`gd_m7dhdot1vw9a7gc1n`) via the
   synchronous `/scrape` endpoint; it usually returns the result inline (~30s),
   falling back to a snapshot ID the page polls for slower runs.
3. It renders the answer, the ranked source list, "people also ask", and a result.
4. Export as Markdown, JSON, or CSV.

| Engine | Dataset ID | Key inputs |
| --- | --- | --- |
| Perplexity | `gd_m7dhdot1vw9a7gc1n` | `url, prompt, country, index` |

Perplexity answers are built around a ranked source list, so it's usually the
clearest place to see whether your domain is cited — when the model returns
sources at all (occasionally it returns none).

---

## Bring Your Own Key (BYOK) — zero secrets

**There is no API token in this repo or in the deployed Worker.** Each visitor
pastes their **own** Bright Data token; it's forwarded per request to Bright Data
and **not stored anywhere** — the Worker keeps no database, doesn't log the token,
and the page does not save it in your browser (no `localStorage`, no cookies).
Your key, your credits — each check uses about **US$0.0015 per record** of **your
own** Bright Data pay-as-you-go balance, and the `/api/*` endpoints are
rate-limited per IP. (A proxy is needed only because Bright Data's API doesn't
send CORS headers, so a browser can't call it directly.)

> This is an independent project — not affiliated with or endorsed by Bright Data,
> OpenAI, or Perplexity.

Create a Bright Data account at [brightdata.com](https://brightdata.com); the API
token lives in your account settings under *API keys*.

---

## Run it yourself

```bash
npm install
npm run dev        # http://localhost:8787
npm run deploy     # deploy to your Cloudflare account
```

No secrets to configure. Click **"See a real sample"** to view a real result for
*ROASPIG* without using a token.

### Raw API example (synchronous)

```bash
curl -H "Authorization: Bearer $BRIGHT_DATA_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"input":[{"url":"https://www.perplexity.ai","prompt":"best AI ad creative tools in 2026","country":"US","index":1}]}' \
  "https://api.brightdata.com/datasets/v3/scrape?dataset_id=gd_m7dhdot1vw9a7gc1n&notify=false&include_errors=true"
```

The app calls the synchronous `/scrape` endpoint above (it returns a `snapshot_id`
to poll for long jobs). Bright Data also offers a fully async flow:
`POST /datasets/v3/trigger` → poll `GET /datasets/v3/progress/{id}` →
download `GET /datasets/v3/snapshot/{id}?format=json`.

---

## Structure

```
perplexity-visibility-checker/
├── public/
│   ├── index.html     # the whole front-end (neo-brutalist, vanilla JS)
│   └── sample.json    # a real sample result for the no-key demo
├── src/
│   └── worker.js      # stateless BYOK proxy
├── wrangler.jsonc
└── package.json
```

---

Built with love by **[Yaron · nofluff.online](https://nofluff.online)** · powered by **Bright Data**. MIT licensed.
