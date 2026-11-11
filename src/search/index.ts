import { config } from '../config';
import { errorMessage, logger } from '../util/log';
import { fetchWithRetry, pMap } from '../util/async';
import { TtlCache } from './cache';

const log = logger('search');

export interface SearchQuery {
  query: string;
  /** Only return results newer than N days — for "has X changed since Monday" style questions. */
  recencyDays?: number;
  /** "general" (default) or "news". */
  topic?: 'general' | 'news';
  maxResults?: number;
}

export interface SearchHit {
  title: string;
  url: string;
  content: string;
  publishedDate?: string;
  score?: number;
}

export interface SearchResponse {
  provider: string;
  query: string;
  answer?: string;
  results: SearchHit[];
  cached: boolean;
}

const cache = new TtlCache<SearchResponse>(config.search.cacheTtlMs);

function normalizeUrl(url: string): string {
  const trimmed = (url ?? '').trim();
  if (!/^https?:\/\//i.test(trimmed)) return '';
  try {
    const parsed = new URL(trimmed);
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '';
  }
}

function dedupe(hits: SearchHit[], limit: number): SearchHit[] {
  const seen = new Set<string>();
  const out: SearchHit[] = [];
  for (const hit of hits) {
    const url = normalizeUrl(hit.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ ...hit, url });
    if (out.length >= limit) break;
  }
  return out;
}

function clampContent(text: string, max: number = config.budgets.searchResultChars): string {
  const clean = (text ?? '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/* ------------------------------------------------------------------ */
/* Providers                                                          */
/* ------------------------------------------------------------------ */

interface TavilyResponse {
  answer?: string;
  results?: Array<{ title?: string; url?: string; content?: string; score?: number; published_date?: string }>;
}

async function tavilySearch(query: SearchQuery): Promise<SearchResponse> {
  const body: Record<string, unknown> = {
    api_key: config.search.tavilyKey,
    query: query.query,
    search_depth: config.search.depth,
    topic: query.topic === 'news' ? 'news' : 'general',
    max_results: Math.min(Math.max(query.maxResults ?? config.search.maxResults, 1), 10),
    include_answer: true,
    include_raw_content: false,
  };
  if (query.recencyDays && query.recencyDays > 0) body['days'] = Math.min(query.recencyDays, 365);

  const response = await fetchWithRetry('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, { timeoutMs: config.search.timeoutMs });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Tavily search failed (${response.status}): ${detail.slice(0, 300)}`);
  }
  const data = (await response.json()) as TavilyResponse;
  const results = dedupe((data.results ?? []).map((r) => ({
    title: r.title ?? '(untitled)',
    url: r.url ?? '',
    content: clampContent(r.content ?? ''),
    publishedDate: r.published_date ?? undefined,
    score: r.score,
  })), Math.min(query.maxResults ?? config.search.maxResults, 10));

  return {
    provider: 'tavily',
    query: query.query,
    answer: data.answer ? clampContent(data.answer, 500) : undefined,
    results,
    cached: false,
  };
}

interface BraveResponse {
  web?: { results?: Array<{ title?: string; url?: string; description?: string; age?: string }> };
}

async function braveSearch(query: SearchQuery): Promise<SearchResponse> {
  const params = new URLSearchParams({ q: query.query, count: String(query.maxResults ?? config.search.maxResults) });
  if (query.recencyDays && query.recencyDays > 0) {
    const d = query.recencyDays;
    params.set('freshness', d <= 1 ? 'pd' : d <= 7 ? 'pw' : d <= 31 ? 'pm' : 'py');
  }
  const response = await fetchWithRetry(`https://api.search.brave.com/res/v1/web/search?${params.toString()}`, {
    headers: { 'X-Subscription-Token': config.search.braveKey, Accept: 'application/json' },
  }, { timeoutMs: config.search.timeoutMs });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Brave search failed (${response.status}): ${detail.slice(0, 300)}`);
  }
  const data = (await response.json()) as BraveResponse;
  const results = dedupe((data.web?.results ?? []).map((r) => ({
    title: r.title ?? '(untitled)',
    url: r.url ?? '',
    content: clampContent(r.description ?? '', 700),
    publishedDate: r.age ?? undefined,
  })), query.maxResults ?? config.search.maxResults);

  return { provider: 'brave', query: query.query, results, cached: false };
}

/**
 * Keyless best-effort fallback (DuckDuckGo HTML endpoint) so the app still
 * demonstrates search end-to-end when no search key is configured. Lower quality
 * than Tavily — snippets only, no page content — and clearly flagged as such.
 */
async function duckduckgoSearch(query: SearchQuery): Promise<SearchResponse> {
  const response = await fetchWithRetry(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query.query)}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:126.0) Gecko/20100101 Firefox/126.0',
      Accept: 'text/html',
    },
  }, { timeoutMs: config.search.timeoutMs, retries: 0 });

  if (!response.ok) throw new Error(`DuckDuckGo fallback failed (${response.status}).`);
  const html = await response.text();

  const hits: SearchHit[] = [];
  const pattern = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    let href = match[1] ?? '';
    if (href.startsWith('//duckduckgo.com/l/?uddg=')) {
      try {
        href = decodeURIComponent(new URL(`https:${href}`).searchParams.get('uddg') ?? '');
      } catch {
        continue;
      }
    }
    const stripTags = (s: string) => clampContent(s.replace(/<[^>]*>/g, ' ').replace(/&[a-z]+;/g, ' '), 700);
    hits.push({
      title: stripTags(match[2] ?? '(untitled)'),
      url: href,
      content: stripTags(match[3] ?? ''),
    });
    if (hits.length >= 10) break;
  }
  const results = dedupe(hits, query.maxResults ?? config.search.maxResults);
  return {
    provider: 'duckduckgo',
    query: query.query,
    results,
    cached: false,
    answer: results.length === 0 ? 'No results found by the keyless fallback.' : undefined,
  };
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

function providerFor(query: SearchQuery): Promise<SearchResponse> {
  switch (config.search.provider) {
    case 'tavily':
      return tavilySearch(query);
    case 'brave':
      return braveSearch(query);
    default:
      return duckduckgoSearch(query);
  }
}

/** Cached, de-duplicated web search. */
export async function webSearch(query: SearchQuery): Promise<SearchResponse> {
  const key = JSON.stringify({ p: config.search.provider, q: query.query, d: query.recencyDays, t: query.topic, m: query.maxResults });
  return cache.get(key, async () => {
    try {
      return await providerFor(query);
    } catch (err) {
      log.error(`Search failed for "${query.query}"`, errorMessage(err));
      // Last-ditch fallback so a provider outage degrades instead of breaking the agent.
      if (config.search.provider !== 'duckduckgo') {
        try {
          return await duckduckgoSearch(query);
        } catch {
          /* fall through */
        }
      }
      throw err;
    }
  });
}

/** Search many queries in parallel (bounded by configured concurrency). */
export async function webSearchMany(queries: SearchQuery[]): Promise<SearchResponse[]> {
  return pMap(queries, config.search.concurrency, (q) => webSearch(q));
}
