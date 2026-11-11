import { config } from '../config';
import { complete, extractJson } from '../llm/client';
import { logger, errorMessage } from '../util/log';
import type { ExtractedMemory, Source, TurnDoc } from './store';

const log = logger('memory-extract');

const EXTRACTION_PROMPT = `You maintain the long-term memory of a chat assistant. Distill the conversation turn below into structured memory for future retrieval.

Return ONLY a JSON object with this shape:
{
  "topic": "short noun phrase naming what the turn is about, e.g. 'Postgres hosting pricing'",
  "entities": ["named products/companies/people/topics discussed"],
  "answerSummary": "1-2 sentence summary of the assistant's answer",
  "claims": [
    { "text": "one specific factual claim made", "sourceUrl": "url it came from or null", "timeSensitive": true }
  ],
  "tags": ["3-6 short retrieval tags"]
}

Rules:
- Include ONLY claims that could change or be re-checked later (prices, versions, availability, rankings, recommendations). Max 6 claims.
- Mark timeSensitive true for anything involving pricing, releases, dates, or versions.
- Keep every string short and information-dense; no prose padding.
- No markdown, no commentary — JSON only.

TURN:
`;

/** Turn one conversation turn into durable structured memory. Best effort — never throws. */
export async function extractMemory(input: {
  turn: TurnDoc;
  model?: string;
  signal?: AbortSignal;
}): Promise<ExtractedMemory | null> {
  const { turn, model = config.openai.fastModel } = input;
  if (!turn.question.trim() || (!turn.answer.trim() && turn.sources.length === 0)) return null;

  const sources = turn.sources.slice(0, 8).map((s: Source) => `- ${s.title} ${s.url}`).join('\n');
  const user = `User asked (${turn.askedAt}): ${turn.question.slice(0, 1500)}

Assistant answered: ${turn.answer.slice(0, 2500)}

Sources used:
${sources || '(none)'}`;

  try {
    const raw = await complete({
      model,
      messages: [
        { role: 'system', content: EXTRACTION_PROMPT },
        { role: 'user', content: user },
      ],
      temperature: 0,
      max_tokens: 500,
      ...(config.openai.jsonMode ? { response_format: { type: 'json_object' as const } } : {}),
    }, input.signal);

    const parsed = extractJson(raw);
    if (!parsed) {
      log.warn('Extraction returned unparseable output; raw turn remains searchable as-is');
      return null;
    }

    const asStringArray = (value: unknown, limit: number): string[] =>
      Array.isArray(value)
        ? value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map((v) => v.trim()).slice(0, limit)
        : [];

    const claims: ExtractedMemory['claims'] = [];
    if (Array.isArray(parsed['claims'])) {
      for (const raw of parsed['claims'] as unknown[]) {
        if (typeof raw !== 'object' || raw === null) continue;
        const obj = raw as Record<string, unknown>;
        const text = typeof obj['text'] === 'string' ? obj['text'].trim() : '';
        if (!text) continue;
        claims.push({
          text: text.slice(0, 400),
          sourceUrl: typeof obj['sourceUrl'] === 'string' ? obj['sourceUrl'] : undefined,
          timeSensitive: obj['timeSensitive'] === true,
        });
        if (claims.length >= 6) break;
      }
    }

    const memory: ExtractedMemory = {
      turnId: turn.id,
      conversationId: turn.conversationId,
      createdAt: turn.answeredAt,
      topic: typeof parsed['topic'] === 'string' ? parsed['topic'].slice(0, 160) : turn.question.slice(0, 80),
      entities: asStringArray(parsed['entities'], 12),
      question: turn.question.slice(0, 400),
      answerSummary: typeof parsed['answerSummary'] === 'string' ? parsed['answerSummary'].slice(0, 500) : turn.answer.slice(0, 300),
      claims,
      tags: asStringArray(parsed['tags'], 8),
      extractionModel: model,
    };
    log.info(`Extracted memory for turn ${turn.id} (${memory.entities.length} entities, ${memory.claims.length} claims)`);
    return memory;
  } catch (err) {
    log.warn(`Memory extraction failed for turn ${turn.id} (raw turn stays searchable)`, errorMessage(err));
    return null;
  }
}
