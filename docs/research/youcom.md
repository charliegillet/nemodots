# You.com developer platform — research notes (2026-10-17)

Sources: https://you.com/docs (llms.txt index at https://you.com/docs/llms.txt; append `.md` to any docs URL for Markdown), https://you.com/resources/you-com-web-search-api, OpenAPI at https://you.com/docs/openapi.json. Everything below was read from the official docs today; the keyless MCP path was verified live with curl.

## TL;DR for Ratchet

- **We do not need a You.com API key to demo search today.** The hosted MCP server at `https://api.you.com/mcp?profile=free` exposes `you-search` and `you-discover` with no auth, 100 queries/day. Verified: a plain JSON-RPC `tools/call` over HTTP returns real results (SSE-framed response). Use this as the degraded path when `YOU_API_KEY` is unset.
- With a key: `POST https://ydc-index.io/v1/search`, header `X-API-Key`, body `{"query": "...", "count": 5}`. Docs' canonical env var is `YDC_API_KEY`; our code reads `YOU_API_KEY` and falls back to `YDC_API_KEY`.
- Official Python SDK: `pip install youdotcom` (PyPI, v3.6.0 today, Python >= 3.10, reads `YDC_API_KEY`). TypeScript: the `@youdotcom-oss/sdk` npm package is **deprecated**; use `fetch` or the MCP package `@youdotcom-oss/mcp` (npm, v4.0.4).
- Add to Claude Code keyless: `claude mcp add --transport http youdotcom "https://api.you.com/mcp?profile=free"`.

## The five REST APIs

All take `X-API-Key`. Keys are scoped per product. Prices as of Sept/Oct 2026 docs.

| API | Endpoint | Returns | Price |
| --- | --- | --- | --- |
| Web Search | `POST https://ydc-index.io/v1/search` (GET still works, frozen) | ranked `results.web` + optional `results.news` + optional `results.knowledge` | $5 / 1k calls; full-page live crawl +$1 / 1k pages |
| Contents | `POST https://ydc-index.io/v1/contents` | markdown/html/metadata for URLs you already have | $1 / 1k pages |
| Answer | `POST https://api.you.com/v1/answer` | one-pass cited Markdown answer + excerpts + web results (p50 2.67s) | $5 / 1k |
| Research | `POST https://api.you.com/v1/research` | multi-step cited Markdown or JSON (`output_schema`); `research_effort` = lite/standard/deep/exhaustive/frontier | $12 (lite) .. $1,200 (frontier) / 1k |
| Finance Research | `POST https://api.you.com/v1/finance_research` | same shape as Research over a finance index; `deep` or `exhaustive` only; no background mode, no `source_control` | $110 (deep) / $500 (exhaustive) / 1k |

Gotcha: Answer/Research/Finance live only on `api.you.com`. Sending them to `ydc-index.io` returns 403 `{"message": "Missing Authentication Token"}` even with a valid key.

Also listed in the API reference index: Billing `GET` account balance, and an Images endpoint (not needed for Ratchet).

### Web Search request body (POST /v1/search)

- `query` (required; supports `site:`, `filetype:`, AND/OR/NOT, quotes)
- `count` 1-100 per section, default 10
- `offset` 0-9 (pages of size `count`)
- `freshness`: `day`|`week`|`month`|`year`|`YYYY-MM-DDtoYYYY-MM-DD` (a time phrase in the query widens, never narrows)
- `country` (fixed 36-code list), `language` (BCP47 list, default `EN`), `safesearch` off|moderate|strict
- `include_domains` (<=500, strict allowlist) OR `exclude_domains` (<=5000) OR `boost_domains` (<=500); `include_domains` with either other list -> 422
- `strict_operators` bool
- `knowledge: "core"` adds licensed-data answers (stock prices etc.), no extra cost
- `extraction: {"extraction_mode": "highlights" | "full_page", "highlights": {"total_max_tokens": 1024-8192}, "full_page": {"extraction_formats": ["markdown","html"]}, "extraction_source": "blend"|"cache"|"fetch"}` (POST only; supersedes deprecated `livecrawl`)
- `crawl_timeout` 1-60s (full_page only)

Recommendation for agent tool use: `extraction_mode: "highlights"` with `count` 3-5 gives token-efficient, query-relevant passages at base price.

### Web Search response shape

```json
{
  "results": {
    "web":  [{"url","title","description","snippets":[...],"page_age","thumbnail_url","favicon_url",
              "contents":{"highlights":[...]} | {"markdown","html"}}],
    "news": [{"url","title","description","page_age","thumbnail_url","contents"?}],
    "knowledge": [{"type":"answer","title","description","attribution":[{"name","source_description"}],"as_of"}]
  },
  "metadata": {"search_uuid","query","latency"}
}
```

`news` and `knowledge` are omitted when empty; `snippets` is omitted in highlights mode. Treat every field as optional.

### Contents request/response

Body: `{"urls": [...], "formats": ["markdown"|"html"|"metadata"], "crawl_timeout": 10, "max_age": null}`.
Response: array of `{"url","title","markdown","html","metadata":{"site_name","favicon_url"}}`.

## Auth, rate limits, errors

- Header `X-API-Key: <key>` on all REST endpoints. MCP server uses `Authorization: Bearer <key>` or OAuth 2.1 instead.
- Env var convention: `YDC_API_KEY` (SDK, MCP package, docs). New accounts get $100 credits, no card.
- Default self-serve limits: 10 req/s on search, contents, answer, research; 5 req/s on finance_research. Response headers `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` (Unix ts). 429 carries `Retry-After`; docs suggest exponential backoff capped at 60s.
- Status codes: 401 bad key, 402 out of credits (body has `upgrade_url`), 403 key lacks scope / wrong host, 422 bad param combination, 429 rate limit, 500 auth middleware error.
- Keyless MCP free profile: 100 queries/day.

## SDKs and packages

| Package | Where | Status |
| --- | --- | --- |
| `youdotcom` | PyPI, https://github.com/youdotcom-oss/youdotcom-python-sdk | official, v3.6.0, typed + async, `from youdotcom import You; You().search(query=...)`; reads `YDC_API_KEY` |
| `@youdotcom-oss/mcp` | npm, https://github.com/youdotcom-oss/mcp | official MCP server (STDIO via `npx @youdotcom-oss/mcp`); env `YDC_API_KEY` or `YDC_PROFILE=free`; `YDC_ALLOWED_TOOLS` |
| `@youdotcom-oss/sdk` | npm | **deprecated** (v0.13.1) — use `fetch` or the MCP package |
| `langchain-youdotcom`, `llama-index-retrievers-you` | PyPI | framework adapters, not needed |
| Agent skills | https://github.com/youdotcom-oss/agent-skills | `you-web`, `you-research`, `you-finance`, `you-discover`; `npx skills add youdotcom-oss/agent-skills` |

## Official MCP server

- Hosted: `https://api.you.com/mcp` (streamable HTTP). Tools: `you-search`, `you-contents`, `you-research`, `you-finance`, `you-balance`, `you-discover`. No `you-answer` tool.
- Default allowlist is `you-search,you-contents,you-balance,you-discover`; `?tools=` or header `X-Allowed-Tools` override; `/mcp/research` and `/mcp/finance` are single-tool paths with no free usage.
- `?profile=free` -> `you-search` + `you-discover`, no auth, 100/day. `?profile=discover` -> `you-discover` only.
- Host overrides for `you-search` via `_meta["com.you.com/search"]` or `X-Search-*` headers (count, include_domains, country, language...).
- Docs search MCP (free, no key): `https://you.com/docs/_mcp/server`, tool `searchDocs`.

### Adding to Claude Code

```bash
# keyless (recommended for today)
claude mcp add --transport http youdotcom "https://api.you.com/mcp?profile=free"

# with a key (never paste the key into a committed file)
claude mcp add --transport http youdotcom https://api.you.com/mcp --header "Authorization: Bearer $YDC_API_KEY"

# OAuth (opens browser; creates/uses a You.com account, so skip for this hackathon)
claude mcp add --transport http youdotcom https://api.you.com/mcp

# full plugin (OAuth sign-in; also skip today)
claude plugin marketplace add youdotcom-oss/agent-skills
claude plugin install you@you-com --scope user
```

## Verified keyless call (curl, 2026-10-17)

```bash
curl -s -X POST "https://api.you.com/mcp?profile=free" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"you-search","arguments":{"query":"python itertools groupby consecutive duplicates","count":3,"extraction":"none"}}}'
```

Returns SSE lines (`event: message` / `data: {...}`); the result's `content[0].text` is the same JSON shape as REST `/v1/search`. `_meta["you/usage"]` reports `sku`, `results_returned`, `extraction_mode`. MCP `extraction` argument is a plain string here: `"none" | "highlights" (default) | "full_page"`.

## Ready-to-use Python snippet (httpx, env YOU_API_KEY, keyless fallback)

```python
"""you_search.py — You.com web search for Ratchet worker/reviewer tools.

Keyed path:  POST https://ydc-index.io/v1/search  (X-API-Key)
Keyless path: hosted MCP free profile (100 queries/day), used when no key is set.
Returns a list of {"title", "url", "text"} dicts; never raises on missing key.
"""
from __future__ import annotations

import json
import os
import httpx

SEARCH_URL = "https://ydc-index.io/v1/search"
MCP_FREE_URL = "https://api.you.com/mcp?profile=free"


def _api_key() -> str | None:
    return os.environ.get("YOU_API_KEY") or os.environ.get("YDC_API_KEY") or None


def _flatten(payload: dict, limit: int) -> list[dict]:
    rows = []
    results = payload.get("results") or {}
    for section in ("web", "news"):
        for hit in results.get(section) or []:
            contents = hit.get("contents") or {}
            passages = contents.get("highlights") or hit.get("snippets") or [hit.get("description") or ""]
            rows.append({"title": hit.get("title", ""), "url": hit.get("url", ""), "text": " ".join(passages)[:1500]})
    return rows[:limit]


def you_search(query: str, count: int = 5, freshness: str | None = None, timeout: float = 20.0) -> list[dict]:
    key = _api_key()
    try:
        if key:
            body = {"query": query, "count": count, "extraction": {"extraction_mode": "highlights"}}
            if freshness:
                body["freshness"] = freshness
            r = httpx.post(SEARCH_URL, json=body, headers={"X-API-Key": key}, timeout=timeout)
            r.raise_for_status()
            return _flatten(r.json(), count)

        # Keyless fallback: MCP JSON-RPC tools/call, response is SSE-framed.
        args = {"query": query[:400], "count": count, "extraction": "highlights"}
        if freshness:
            args["freshness"] = freshness
        rpc = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "you-search", "arguments": args}}
        r = httpx.post(
            MCP_FREE_URL,
            json=rpc,
            headers={"Accept": "application/json, text/event-stream"},
            timeout=timeout,
        )
        r.raise_for_status()
        for line in r.text.splitlines():
            if not line.startswith("data:"):
                continue
            msg = json.loads(line[5:].strip())
            if "result" in msg:
                text = msg["result"]["content"][0]["text"]
                return _flatten(json.loads(text), count)
        return []
    except (httpx.HTTPError, ValueError, KeyError, IndexError) as exc:  # degrade gracefully
        return [{"title": "search unavailable", "url": "", "text": f"You.com search failed: {type(exc).__name__}"}]


if __name__ == "__main__":
    for row in you_search("python itertools groupby consecutive duplicates", count=3):
        print(row["title"], "->", row["url"])
```

Tool schema for the OpenAI-compatible Crusoe call:

```python
YOU_SEARCH_TOOL = {
    "type": "function",
    "function": {
        "name": "web_search",
        "description": "Search the web (You.com) for docs, error messages, or library usage. Returns titles, URLs and relevant passages.",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "One intent, phrased naturally, max 400 chars"},
                "count": {"type": "integer", "minimum": 1, "maximum": 10, "default": 5},
            },
            "required": ["query"],
        },
    },
}
```

## Blockers / notes

- No You.com key in `.env`. Keyed REST path is untested locally; keyless MCP path is tested and working. Do not sign up; if organizers hand out a key, set `YOU_API_KEY` (or `YDC_API_KEY`) in `.env` and the same code switches to REST with highlights.
- Keyless quota is 100 queries/day per client; budget worker tool calls (cap searches per task, cache by query string).
- Never log the key; never commit `.env`.
