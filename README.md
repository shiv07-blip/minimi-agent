# Minimi — a memory-aware chat agent with live web search

Minimi is a chat agent with **one tool: web search** — and a durable memory that makes
the search *smart*. It remembers what it told you, when it told you, and what it based
it on, so you can come back days later and ask:

- *"On Monday we shortlisted 5 CRM tools. Has any of them changed pricing or shipped something big since?"*
- *"What did I ask you on 3 November? Is your answer still correct today?"*
- *"Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"*

All three are memory-then-verify questions, and all three work: the agent retrieves the
past conversation by date/topic, re-checks the live web, and tells you what changed
versus what still holds — with sources and dates.

## Quick start

```bash
npm install
cp .env.example .env   # add OPENAI_API_KEY, and TAVILY_API_KEY for best search
npm run dev            # http://localhost:3000
```

The server starts even without keys (the UI shows exactly what's missing). Without a
search key it falls back to a keyless DuckDuckGo provider so everything still works.

**Keys** (all listed in `.env.example`):

| Key | Required | Notes |
|---|---|---|
| `OPENAI_API_KEY` | yes | Any OpenAI-compatible API (OpenAI, Groq, OpenRouter, local vLLM…) via `OPENAI_BASE_URL` |
| `TAVILY_API_KEY` | recommended | Primary search provider — LLM-friendly results with page content |
| `BRAVE_API_KEY` | optional | Alternative search provider |
| `MODEL` / `FAST_MODEL` | optional | Main + memory-extraction models (`gpt-4o` / `gpt-4o-mini` by default) |

## How to try the demo flow

1. **Seed some memory:** ask *"Shortlist 5 CRM tools for a 20-person sales team, with current pricing"* (or the Postgres-hosting example). Every turn is distilled into structured memory: topic, entities, time-sensitive claims, sources.
2. **Come back later (or immediately) and ask:** *"On Monday we shortlisted 5 CRM tools — has any of them changed pricing since?"* You'll see a **🧠 recalled** badge, live searches for each tool in parallel, and a what-changed / what-still-holds answer with sources.
3. **Inspect the machinery:** open the **🧠 Memory** drawer (bottom-left) and try retrieval queries yourself, e.g. *"what did I ask on 3 November"*. That endpoint is exactly what the agent uses internally.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Start in watch mode (tsx) |
| `npm start` | Start normally |
| `npm test` | 25 unit tests: temporal parsing, memory retrieval, BM25 ranking |
| `npm run typecheck` | `tsc --noEmit` |

## Architecture at a glance

```
Browser (public/)  ──SSE──▶  HTTP server (src/server.ts)
                              │
                              ▼
                     Agent loop (src/agent/loop.ts)
                     retrieve memory ─▶ build prompt ─▶ stream model
                              │                           │ tool_calls
                              │                           ▼
                              │                    web_search (parallel)
                              ▼
                    Memory layer (src/memory/)
                    store.ts (durable JSON) · dates.ts (temporal parsing)
                    retrieve.ts (BM25 + date filter) · extract.ts (background distillation)
```

- **One tool, used well** — `web_search` (Tavily → Brave → keyless DuckDuckGo), called in parallel for multi-entity checks, results TTL-cached.
- **Memory is internal, not a tool** — retrieval happens automatically before every turn, so the model never "forgets" to remember.
- **Write-time distillation** — after each answer, a cheap model extracts topic/entities/claims/sources in the background; raw turns remain searchable even if extraction fails.
- **Temporal reasoning** — "last Tuesday", "3 November", "since Monday" are resolved to concrete dates in the user's timezone, including ambiguity candidates ("last Tuesday" = most recent *or* previous week's Tuesday; retrieval picks whichever actually matches).
- **Streaming everywhere** — tokens, search statuses, sources and memory-recall badges arrive as SSE events; first visible token depends only on the model.

See [DESIGN.md](DESIGN.md) for the reasoning, trade-offs and rejected alternatives.

## Data & privacy

Everything lives in `data/state.json` (gitignored): conversations, messages, extracted
memory, sources. No external database, no telemetry. Delete the file (or a conversation
in the UI) to wipe memory.

## Notes

- Port is configurable (`PORT=3123 npm run dev` if 3000 is busy).
- All model calls degrade gracefully when a provider rejects optional params (temperature, caps, JSON mode).
- Search result text is treated as untrusted input (prompt-injection aware); the system prompt forbids following instructions embedded in results.
