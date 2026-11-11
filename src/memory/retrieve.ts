import { config } from '../config';
import { getLocalParts, humanDate, resolveTemporal, ymd, daysBetween } from './dates';
import type { Source, TurnDoc } from './store';
import type { TemporalContext, TemporalReference } from './dates';

/* ------------------------------------------------------------------ */
/* Lexical scoring (BM25 over weighted fields)                         */
/* ------------------------------------------------------------------ */

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'else', 'when', 'at', 'by', 'for', 'with',
  'about', 'into', 'through', 'during', 'to', 'from', 'up', 'down', 'in', 'out', 'on', 'off',
  'over', 'under', 'again', 'further', 'once', 'here', 'there', 'all', 'any', 'both', 'each',
  'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same',
  'so', 'than', 'too', 'very', 'can', 'will', 'just', 'did', 'does', 'was', 'were', 'been',
  'being', 'have', 'has', 'had', 'having', 'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he',
  'she', 'it', 'they', 'them', 'this', 'that', 'these', 'those', 'of', 'as', 'is', 'are', 'am',
  'what', 'which', 'who', 'whom', 'how', 'why', 'where', 'do',
]);

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9+#.]*/g) ?? [])
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t))
    .map((t) => t.replace(/\.$/, ''));
}

/** Question and entities weigh more than the (long) answer body. */
function docTokens(doc: TurnDoc): string[] {
  const memory = doc.memory;
  const question = tokenize(doc.question);
  const answer = tokenize(doc.answer);
  const entities = memory ? memory.entities.flatMap((e) => tokenize(e)) : [];
  const topic = memory ? tokenize(memory.topic) : [];
  const claims = memory ? memory.claims.flatMap((c) => tokenize(c.text)) : [];
  return [
    ...question, ...question, ...question, // 3x
    ...entities, ...entities, // 2x
    ...topic, ...topic, // 2x
    ...claims, // 1x
    ...answer, // 1x
  ];
}

interface Bm25Index {
  tokensByDoc: string[][];
  idf: Map<string, number>;
  avgLength: number;
}

function buildIndex(docs: TurnDoc[]): Bm25Index {
  const tokensByDoc = docs.map(docTokens);
  const df = new Map<string, number>();
  for (const tokens of tokensByDoc) {
    for (const term of new Set(tokens)) df.set(term, (df.get(term) ?? 0) + 1);
  }
  const n = Math.max(1, docs.length);
  const idf = new Map<string, number>();
  for (const [term, freq] of df) idf.set(term, Math.log(1 + (n - freq + 0.5) / (freq + 0.5)));
  const avgLength = tokensByDoc.reduce((sum, t) => sum + t.length, 0) / n;
  return { tokensByDoc, idf, avgLength: Math.max(1, avgLength) };
}

function bm25Score(queryTokens: string[], docTokens: string[], index: Bm25Index): number {
  if (queryTokens.length === 0) return 0;
  const k1 = 1.2;
  const b = 0.75;
  const counts = new Map<string, number>();
  for (const t of docTokens) counts.set(t, (counts.get(t) ?? 0) + 1);
  let score = 0;
  for (const term of queryTokens) {
    const tf = counts.get(term);
    if (!tf) continue;
    const idf = index.idf.get(term) ?? 0;
    score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (docTokens.length / index.avgLength))));
  }
  return score;
}

/* ------------------------------------------------------------------ */
/* Retrieval                                                           */
/* ------------------------------------------------------------------ */

export interface RetrievedMemory {
  id: string;
  conversationId: string;
  conversationTitle: string;
  askedAt: string;
  dateYmd: string;
  dateLabel: string;
  question: string;
  answer: string;
  topic?: string;
  entities: string[];
  claims: Array<{ text: string; sourceUrl?: string; timeSensitive: boolean }>;
  sources: Source[];
  score: number;
  matchedReference: string | null;
}

export interface RetrievalResult {
  items: RetrievedMemory[];
  temporal: TemporalContext;
  /** True when the query carried an explicit date/weekday reference. */
  dateScoped: boolean;
  totalTurns: number;
}

function localYmdOf(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return ymd(getLocalParts(date, timeZone));
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/**
 * Retrieve past turns relevant to a query.
 *
 * Two paths, chosen by the query itself:
 *  1. Date-scoped ("what did I ask on 3 November", "since Monday") — filter
 *     turns to the resolved day(s)/range; if the query also carries topic
 *     words, topic relevance orders the results (this disambiguates e.g.
 *     "last Tuesday I asked about Postgres hosting" between candidate days).
 *  2. Topic-scoped — BM25 over question/entities/answer/claims.
 */
export function retrieveMemory(
  turns: TurnDoc[],
  query: string,
  opts: { timeZone?: string; now?: Date; maxItems?: number; excludeTurnIds?: Set<string> } = {},
): RetrievalResult {
  const timeZone = opts.timeZone ?? config.timezone;
  const now = opts.now ?? new Date();
  const maxItems = opts.maxItems ?? config.agent.memoryMaxItems;
  const temporal = resolveTemporal(query, timeZone, now);

  const exclude = opts.excludeTurnIds ?? new Set<string>();
  const candidates = turns.filter((t) => !exclude.has(t.id) && t.question.trim().length > 0);

  const targetDays = new Set<string>(temporal.references.flatMap((r) => r.dates));
  const ranges = temporal.references
    .map((r) => r.range)
    .filter((r): r is { from: string; to: string } => r !== undefined);
  const dateScoped = targetDays.size > 0 || ranges.length > 0;

  // Remove temporal phrases so scoring focuses on the topic, not the dates.
  let topicalQuery = query;
  for (const ref of temporal.references) {
    topicalQuery = topicalQuery.replace(ref.phrase, ' ');
  }
  // Strip conversational filler; keep content words like "pricing" or "changed"
  // which are what distinguish same-day turns from each other.
  topicalQuery = topicalQuery.replace(
    /\b(what|which|when|did|do|does|ask|asked|say|said|tell|told|you|we|us|talk|talked|spoke|speak|discuss|discussed|about|question|answer|answered|since|still|correct|today|any|of|them|there|that|this|it|now|recently|latest)\b/gi,
    ' ',
  );
  const queryTokens = tokenize(topicalQuery);

  const scored = candidates.map((doc) => {
    const dateYmd = localYmdOf(doc.askedAt, timeZone);
    let matchedReference: string | null = null;
    let dateMatch = false;
    if (targetDays.has(dateYmd)) {
      dateMatch = true;
      const ref = temporal.references.find((r) => r.dates.includes(dateYmd));
      matchedReference = ref?.phrase ?? null;
    } else if (ranges.some((r) => dateYmd >= r.from && dateYmd <= r.to)) {
      dateMatch = true;
      const ref = temporal.references.find((r) => r.range && dateYmd >= r.range.from && dateYmd <= r.range.to);
      matchedReference = ref?.phrase ?? null;
    }
    return { doc, dateYmd, dateMatch, matchedReference };
  });

  const index = buildIndex(candidates);
  const withText = scored.map((entry) => ({
    ...entry,
    textScore: bm25Score(queryTokens, index.tokensByDoc[candidates.indexOf(entry.doc)] ?? [], index),
  }));

  let picked: typeof withText = [];
  if (dateScoped) {
    const dateMatches = withText.filter((e) => e.dateMatch);
    if (dateMatches.length > 0) {
      // Topic words present? Prefer same-day turns that also match the topic.
      const topicMatches = dateMatches.filter((e) => e.textScore > 0);
      picked = topicMatches.length > 0 && queryTokens.length > 0 ? topicMatches : dateMatches;
    } else {
      picked = []; // no conversations on that date — caller reports this honestly
    }
  } else if (queryTokens.length > 0) {
    picked = withText.filter((e) => e.textScore > 0);
  } else {
    picked = []; // empty query handled as "recent" by the caller if wanted
  }

  const sortScore = (e: (typeof withText)[number]): number =>
    e.textScore + (e.dateMatch ? 5 : 0);

  if (dateScoped) {
    // Chronological order reads best for "what did we discuss that day".
    picked.sort((a, b) => sortScore(b) - sortScore(a) || a.doc.askedAt.localeCompare(b.doc.askedAt));
  } else {
    picked.sort((a, b) => sortScore(b) - sortScore(a) || b.doc.askedAt.localeCompare(a.doc.askedAt));
  }

  const items: RetrievedMemory[] = picked.slice(0, maxItems).map((e) => ({
    id: e.doc.id,
    conversationId: e.doc.conversationId,
    conversationTitle: e.doc.conversationTitle,
    askedAt: e.doc.askedAt,
    dateYmd: e.dateYmd,
    dateLabel: humanDate(e.dateYmd, 'long'),
    question: truncate(e.doc.question, config.budgets.questionPreview),
    answer: truncate(e.doc.answer, config.budgets.answerPreview),
    topic: e.doc.memory?.topic,
    entities: e.doc.memory?.entities ?? [],
    claims: e.doc.memory?.claims ?? [],
    sources: e.doc.sources,
    score: Math.round(sortScore(e) * 100) / 100,
    matchedReference: e.matchedReference,
  }));

  return { items, temporal, dateScoped, totalTurns: candidates.length };
}

/** Most recent turns — used by the memory inspector when no query is given. */
export function recentMemories(turns: TurnDoc[], timeZone = config.timezone, limit = 20): RetrievedMemory[] {
  return [...turns]
    .filter((t) => t.question.trim().length > 0)
    .sort((a, b) => b.askedAt.localeCompare(a.askedAt))
    .slice(0, limit)
    .map((doc) => ({
      id: doc.id,
      conversationId: doc.conversationId,
      conversationTitle: doc.conversationTitle,
      askedAt: doc.askedAt,
      dateYmd: localYmdOf(doc.askedAt, timeZone),
      dateLabel: humanDate(localYmdOf(doc.askedAt, timeZone), 'long'),
      question: truncate(doc.question, config.budgets.questionPreview),
      answer: truncate(doc.answer, config.budgets.answerPreview),
      topic: doc.memory?.topic,
      entities: doc.memory?.entities ?? [],
      claims: doc.memory?.claims ?? [],
      sources: doc.sources,
      score: 0,
      matchedReference: null,
    }));
}

/** Smallest useful "since" bound, e.g. for hinting recency-limited searches. */
export function sinceDaysHint(references: TemporalReference[], todayYmd: string): number | undefined {
  let min: number | undefined;
  for (const ref of references) {
    for (const date of ref.dates) {
      const diff = daysBetween(date, todayYmd);
      if (diff > 0 && (min === undefined || diff < min)) min = diff;
    }
    if (ref.range) {
      const diff = daysBetween(ref.range.from, todayYmd);
      if (diff > 0 && (min === undefined || diff < min)) min = diff;
    }
  }
  return min;
}
