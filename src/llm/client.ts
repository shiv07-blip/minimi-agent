import OpenAI from 'openai';
import { config } from '../config';
import { errorMessage, logger } from '../util/log';

const log = logger('llm');

export type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
export type ToolDefinition = OpenAI.Chat.Completions.ChatCompletionTool;

let client: OpenAI | null = null;

/** Lazily construct the OpenAI-compatible client (works with OpenAI, Groq, OpenRouter, vLLM...). */
export function getClient(): OpenAI {
  if (!config.openai.apiKey) {
    throw new Error('OPENAI_API_KEY is not set. Copy .env.example to .env and add your key.');
  }
  if (!client) {
    client = new OpenAI({
      apiKey: config.openai.apiKey,
      baseURL: config.openai.baseURL,
      timeout: 120_000,
      maxRetries: 1,
    });
  }
  return client;
}

export function isAbort(err: unknown): boolean {
  const name = (err as { name?: string; code?: string })?.name ?? (err as { code?: string })?.code;
  return name === 'AbortError' || name === 'aborted' || name === 'APIUserAbortError';
}

/** Providers/models disagree about `temperature`, `max_tokens`, `response_format` — degrade gracefully. */
function isUnsupportedParamError(err: unknown): boolean {
  const msg = errorMessage(err).toLowerCase();
  return (
    msg.includes('unsupported') ||
    msg.includes('unrecognized') ||
    msg.includes('does not support') ||
    msg.includes('not supported') ||
    msg.includes('max_tokens is not supported') ||
    msg.includes('temperature is not supported') ||
    msg.includes('response_format') ||
    msg.includes('json_object')
  );
}

type CreateParams = Parameters<OpenAI['chat']['completions']['create']>[0];

/** Drop params that some models/providers reject (temperature, caps, response_format). */
function stripOptionalParams(params: CreateParams): CreateParams {
  const clone = { ...params } as unknown as Record<string, unknown>;
  delete clone['temperature'];
  delete clone['max_tokens'];
  delete clone['response_format'];
  return clone as unknown as CreateParams;
}

/**
 * Create a streaming chat completion; retries once without optional params
 * (temperature / max_tokens / response_format) for models that reject them.
 */
export async function streamCompletion(params: CreateParams, signal?: AbortSignal): Promise<AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>> {
  const client = getClient();
  try {
    return await client.chat.completions.create({ ...params, stream: true }, { signal });
  } catch (err) {
    if (isAbort(err)) throw err;
    if (isUnsupportedParamError(err)) {
      log.warn('Retrying without optional params (model rejected them)', errorMessage(err));
      return await client.chat.completions.create({ ...stripOptionalParams(params), stream: true }, { signal });
    }
    throw err;
  }
}

/** Non-streaming completion with the same graceful degradation; used for background memory extraction. */
export async function complete(params: CreateParams, signal?: AbortSignal): Promise<string> {
  const client = getClient();
  const run = async (p: CreateParams) => {
    const response = await client.chat.completions.create({ ...p, stream: false }, { signal });
    return response.choices[0]?.message?.content ?? '';
  };
  try {
    return await run({ ...params, stream: false });
  } catch (err) {
    if (isAbort(err)) throw err;
    if (isUnsupportedParamError(err)) {
      log.warn('Retrying without optional params (model rejected them)', errorMessage(err));
      return await run({ ...stripOptionalParams(params), stream: false });
    }
    throw err;
  }
}

/** Leniently extract a JSON object from a model response (models wrap JSON in prose or fences). */
export function extractJson(text: string): Record<string, unknown> | null {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(trimmed.slice(start, end + 1));
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
    } catch {
      /* fall through */
    }
  }
  return null;
}
