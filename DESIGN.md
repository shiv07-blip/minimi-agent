# DESIGN — Minimi

## The insight

The three example prompts are not search questions. *"Has pricing changed since Monday?"*, *"Is your answer from 3 November still correct?"*, *"Last Tuesday I asked you about Postgres hosting"* — every one is a **memory-then-verify** question. A chat agent with a web-search tool gets these wrong unless the *memory* half is a first-class subsystem, not a chat history dump. So the architecture has two engines: a **durable memory** (what was said, when, based on which sources) and a **live web search** (what is true now) — and the agent's core skill is reconciling the two with dates attached to everything.

## How it works

**Request lifecycle** (one user message → streamed answer):

1. **Temporal parsing** (`memory/dates.ts`) — regex-based resolution of "3 November", "last Tuesday", "since Monday", "last week" into concrete dates in the *user's* timezone (sent by the browser, no timezone library: `Intl` gives local Y/M/D, calendar math runs on plain UTC dates). Ambiguous phrases produce *candidates*: "last Tuesday" on a Wednesday yields both yesterday and the previous week's Tuesday.
2. **Memory retrieval** (`memory/retrieve.ts`) — the corpus is every past question/answer turn, enriched by structured memories. Date references filter turns to the resolved day/range; topic scoring is BM25 over weighted fields (question ×3, entities ×2, claims, answer). Candidates + topic together disambiguate: "last Tuesday, Postgres hosting" picks whichever Tuesday actually has that conversation. Retrieval is **internal and automatic** — memory is context, not a tool the model can forget to call.
3. **Agent loop** (`agent/loop.ts`) — hand-rolled: system prompt (date context + recalled memory with timestamps + freshness rules) → streamed model call → if the model emits tool calls, run every `web_search` **in parallel** → feed results back → repeat (capped at 6 rounds; last round forced tool-free so an answer always comes).
4. **Answer** streams token-by-token over SSE, with status events ("Searching the web: …"), source cards, and a "🧠 recalled N conversations" badge showing exactly which memory was used.
5. **Write-time distillation** (`memory/extract.ts`) — after the answer, a cheap model extracts topic, entities, time-sensitive claims and sources into structured memory, in the background; the raw turn stays searchable even if extraction fails. Memory only costs latency you never feel.

**Why these choices:** one tool keeps the loop debuggable and honest — depth comes from the search provider's extracted page content rather than a second fetch tool. BM25 + date filters over a few hundred personal turns beats a vector DB here: no embedding API, no extra key, deterministic, explainable in an interview, and dates — the strongest signal for this workload — are trivial to filter. Hand-rolling the loop (no LangChain) gives sub-millisecond orchestration overhead, exact control over streaming/parallel tool calls, and zero framework churn. The single-tool constraint is enforced in code, not just prompted.

**What I rejected:** vector embeddings for retrieval (overkill at personal-memory scale; adds a key, latency, and a worse date story); a `recall_memory` tool (violates the one-tool rule and the model can skip it); frameworks (opaque failure modes, slower cold start); re-scraping old sources to diff "has it changed" (fragile — pricing pages change layout; searching *for* the change with the old claim as baseline is more robust); auto-seeded fake history (dishonest — the honest "I have no conversation on that date" is the correct answer when memory is empty, and asking a short clarifying question beats guessing which 5 tools).

**Speed:** streaming throughout; parallel tool calls; TTL-cached searches with in-flight dedup; bounded concurrency (4) to respect rate limits; tight context budgets (memory ≤ 7k chars, trimmed tool output); background memory extraction. End-to-end latency to first token is the model's first token; a 5-entity change check costs one model round + one parallel search wave (~1–3s in practice).

**Correctness:** the system prompt hard-separates *what was said* (memory, timestamped) from *what is true* (web); time-sensitive claims must be verified before answering; answers cite sources with "as of" dates; ambiguity in dates is surfaced rather than silently guessed; search result text is treated as untrusted data (injection-aware).

## Limitations & next week

Single-user by design (local `state.json`, atomic writes, debounced flush — SQLite at scale). Retrieval is lexical, so heavy paraphrase can miss. No scheduled re-verification of stored claims.

With another week: **(1)** a claim-diff engine — nightly job re-searching each time-sensitive claim and flagging drifted ones ("your Postgres answer changed: Neon pricing updated Tuesday"); **(2)** hybrid retrieval (embeddings fused with BM25, still date-first); **(3)** an eval harness scripted around exactly these dataset prompts, run in CI against a mock LLM (the mock I built for integration tests is the seed of this); **(4)** conversation compaction for months-long histories; **(5)** auth + per-user storage.
