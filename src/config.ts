import 'dotenv/config';

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return /^(1|true|yes|y)$/i.test(raw.trim());
}

function str(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === '' ? fallback : raw.trim();
}

const tavilyKey = str('TAVILY_API_KEY', '');
const braveKey = str('BRAVE_API_KEY', '');

export type SearchProviderName = 'tavily' | 'brave' | 'duckduckgo';

function pickSearchProvider(): SearchProviderName {
  if (tavilyKey) return 'tavily';
  if (braveKey) return 'brave';
  return 'duckduckgo';
}

export const config = {
  port: num('PORT', 3000),
  timezone: str('TIMEZONE', 'UTC'),
  dataDir: str('DATA_DIR', './data'),
  openai: {
    apiKey: process.env.OPENAI_API_KEY?.trim() ?? '',
    baseURL: process.env.OPENAI_BASE_URL?.trim() || undefined,
    model: str('MODEL', 'gpt-4o'),
    fastModel: str('FAST_MODEL', str('MODEL', 'gpt-4o')),
    jsonMode: bool('JSON_MODE', true),
  },
  search: {
    provider: pickSearchProvider(),
    tavilyKey,
    braveKey,
    cacheTtlMs: num('SEARCH_CACHE_TTL_MS', 10 * 60_000),
    depth: str('SEARCH_DEPTH', 'advanced') === 'basic' ? 'basic' : 'advanced',
    maxResults: 6,
    concurrency: 4,
    timeoutMs: 20_000,
  },
  agent: {
    maxToolIterations: num('MAX_TOOL_ITERATIONS', 6),
    historyMessages: num('HISTORY_MESSAGES', 16),
    memoryMaxItems: num('MEMORY_MAX_ITEMS', 8),
    temperature: 0.3,
    maxTokens: 1600,
  },
  /** Character budgets for the context window (keeps prompts tight and fast). */
  budgets: {
    memoryCharsPerItem: 900,
    memoryTotalChars: 7000,
    questionPreview: 700,
    answerPreview: 900,
    searchResultChars: 1200,
  },
} as const;

/** Problems that make the app non-functional, reported at startup and on /api/health. */
export function configProblems(): string[] {
  const problems: string[] = [];
  if (!config.openai.apiKey) {
    problems.push('OPENAI_API_KEY is not set — the agent cannot answer. Add it to .env (see .env.example).');
  }
  if (config.search.provider === 'duckduckgo') {
    problems.push(
      'No TAVILY_API_KEY (or BRAVE_API_KEY) set — using the keyless DuckDuckGo fallback. ' +
        'Search quality will be reduced; add TAVILY_API_KEY for best results.',
    );
  }
  return problems;
}
