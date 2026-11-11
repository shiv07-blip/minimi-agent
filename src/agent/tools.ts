import { config } from '../config';
import { webSearch, type SearchQuery } from '../search';
import type { Source } from '../memory/store';
import { newId } from '../util/ids';
import type { ToolDefinition } from '../llm/client';

/**
 * The agent's single tool. One tool keeps the loop simple, fast and debuggable;
 * depth (fetching full pages) is covered by the search provider's extracted
 * page content rather than a second tool.
 */
export const TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        'Search the live web. Returns ranked results with title, URL, snippet, page extract and published date. ' +
        'Call multiple times in one turn to check several entities in parallel. ' +
        'Use recencyDays when the question is anchored to a date ("has X changed since Monday").',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query. Keep it focused; add "pricing", "changelog", or the month/year when checking for changes.',
          },
          recencyDays: {
            type: 'integer',
            description: 'Only return results newer than this many days. Use for "since <date>" questions; omit otherwise.',
          },
          topic: {
            type: 'string',
            enum: ['general', 'news'],
            description: '"news" for current events and announcements; "general" (default) for everything else.',
          },
          maxResults: {
            type: 'integer',
            description: 'Number of results to return (1-8). Default 6.',
          },
        },
        required: ['query'],
      },
    },
  },
];

export interface ToolOutcome {
  resultText: string;
  sources: Source[];
}

interface SearchArgs {
  query?: unknown;
  recencyDays?: unknown;
  topic?: unknown;
  maxResults?: unknown;
}

function parseArgs(argsJson: string): SearchArgs & { error?: string } {
  try {
    const parsed = JSON.parse(argsJson || '{}');
    if (typeof parsed === 'object' && parsed !== null) return parsed as SearchArgs;
    return { error: 'Arguments must be a JSON object.' };
  } catch {
    return { error: 'Arguments were not valid JSON.' };
  }
}

function toSource(hit: { title: string; url: string; content: string; publishedDate?: string }): Source {
  return {
    title: hit.title,
    url: hit.url,
    snippet: hit.content.slice(0, 300),
    publishedDate: hit.publishedDate,
    accessedAt: new Date().toISOString(),
  };
}

export async function executeSearchTool(argsJson: string): Promise<ToolOutcome> {
  const args = parseArgs(argsJson);
  if (args.error) return { resultText: JSON.stringify({ error: args.error }), sources: [] };

  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (!query) return { resultText: JSON.stringify({ error: 'Missing "query".' }), sources: [] };

  const searchQuery: SearchQuery = {
    query: query.slice(0, 400),
    recencyDays:
      typeof args.recencyDays === 'number' && Number.isFinite(args.recencyDays)
        ? Math.min(Math.max(Math.round(args.recencyDays), 1), 365)
        : undefined,
    topic: args.topic === 'news' ? 'news' : 'general',
    maxResults:
      typeof args.maxResults === 'number' && Number.isFinite(args.maxResults)
        ? Math.min(Math.max(Math.round(args.maxResults), 1), 8)
        : config.search.maxResults,
  };

  try {
    const response = await webSearch(searchQuery);
    const sources = response.results.map(toSource);
    const payload = {
      provider: response.provider,
      query: response.query,
      answer: response.answer,
      note: response.cached ? 'results from a short-lived cache' : undefined,
      results: response.results.map((r) => ({
        title: r.title,
        url: r.url,
        published: r.publishedDate,
        content: r.content,
      })),
    };
    return { resultText: JSON.stringify(payload), sources };
  } catch (err) {
    return {
      resultText: JSON.stringify({ error: `web_search failed: ${(err as Error).message}. Try a simpler query or proceed without search.` }),
      sources: [],
    };
  }
}

export function newSourceId(): string {
  return newId('src');
}
