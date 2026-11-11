import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retrieveMemory, sinceDaysHint } from '../src/memory/retrieve';
import type { TurnDoc } from '../src/memory/store';

// Fixed "now": Wednesday, 11 November 2026, 13:05 UTC.
const NOW = new Date('2026-11-11T13:05:00Z');
const TZ = 'UTC';

let n = 0;
function turn(question: string, answer: string, askedAt: string): TurnDoc {
  n += 1;
  return {
    id: `t${n}`,
    conversationId: 'conv1',
    conversationTitle: 'Research',
    question,
    answer,
    askedAt,
    answeredAt: askedAt,
    sources: [],
  };
}

const TURNS: TurnDoc[] = [
  // Monday 9 Nov: the CRM shortlist.
  turn(
    'Shortlist 5 CRM tools for a 20-person sales team with pricing',
    'HubSpot Starter $15/seat, Pipedrive Essential $14, Close Starter $25, Freshsales Growth $9, Zoho Standard $14.',
    '2026-11-09T10:12:00Z',
  ),
  // Tuesday 10 Nov: Postgres hosting (the "yesterday" interpretation of "last Tuesday").
  turn(
    'Which is better for Postgres hosting: Supabase or Neon?',
    'Supabase free tier then $25/mo Pro; Neon has a free tier with usage-based scaling.',
    '2026-11-10T09:30:00Z',
  ),
  // Tuesday 3 Nov: Postgres hosting (the "previous week" interpretation).
  turn(
    'Compare Postgres hosting options for a small project',
    'Supabase, Neon and Railway all have free/cheap tiers; Neon is serverless Postgres.',
    '2026-11-03T15:00:00Z',
  ),
  // Unrelated filler.
  turn('What is the capital of France?', 'Paris.', '2026-11-04T12:00:00Z'),
  turn('Recommend a podcast about batteries.', 'The Battery Show.', '2026-10-28T12:00:00Z'),
];

test('date-scoped recall finds everything asked on a specific date', () => {
  const result = retrieveMemory(TURNS, 'What did I ask you on 3 November? Is your answer still correct today?', {
    timeZone: TZ,
    now: NOW,
  });
  assert.equal(result.dateScoped, true);
  assert.equal(result.items.length, 1);
  assert.match(result.items[0]?.question ?? '', /Postgres hosting/);
  assert.equal(result.items[0]?.dateYmd, '2026-11-03');
});

test('topic + date disambiguates between candidate days for "last Tuesday"', () => {
  // Both Tue 10 Nov and Tue 3 Nov mention Postgres; topic scoring should rank
  // whichever is more relevant, and both candidates should be retrievable.
  const result = retrieveMemory(TURNS, 'Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?', {
    timeZone: TZ,
    now: NOW,
  });
  assert.equal(result.dateScoped, true);
  assert.ok(result.items.length >= 1);
  for (const item of result.items) {
    assert.ok(item.dateYmd === '2026-11-10' || item.dateYmd === '2026-11-03');
    assert.match(item.question, /Postgres/i);
  }
});

test('weekday recall picks up the Monday conversation', () => {
  const result = retrieveMemory(TURNS, 'On Monday we shortlisted 5 CRM tools. Has any of them changed pricing since?', {
    timeZone: TZ,
    now: NOW,
  });
  assert.equal(result.dateScoped, true);
  assert.equal(result.items.length, 1);
  assert.match(result.items[0]?.answer ?? '', /HubSpot/);
});

test('topic search without dates matches the right turn', () => {
  const result = retrieveMemory(TURNS, 'what did we say about postgres hosting', {
    timeZone: TZ,
    now: NOW,
  });
  assert.ok(result.items.length >= 1);
  assert.match(result.items[0]?.question ?? '', /Postgres/i);
  assert.equal(result.dateScoped, false);
});

test('no records for a date returns an honest empty result', () => {
  const result = retrieveMemory(TURNS, 'What did I ask you on 1 January?', {
    timeZone: TZ,
    now: NOW,
  });
  assert.equal(result.dateScoped, true);
  assert.equal(result.items.length, 0);
});

test('excluded turns are skipped (the in-flight message never recalls itself)', () => {
  const current = TURNS[0] as TurnDoc;
  const result = retrieveMemory(TURNS, 'CRM tools pricing', {
    timeZone: TZ,
    now: NOW,
    excludeTurnIds: new Set([current.id]),
  });
  assert.ok(result.items.every((item) => item.id !== current.id));
});

test('extracted memory fields boost and enrich retrieval', () => {
  const enriched = TURNS.map((t) =>
    t.id === 't3'
      ? {
          ...t,
          memory: {
            turnId: t.id,
            conversationId: 'conv1',
            createdAt: t.answeredAt,
            topic: 'Postgres hosting pricing',
            entities: ['Supabase', 'Neon', 'Railway'],
            question: t.question,
            answerSummary: 'Compared Postgres hosting options',
            claims: [{ text: 'Supabase Pro is $25/month', timeSensitive: true }],
            tags: ['postgres', 'hosting'],
            extractionModel: 'test',
          },
        }
      : t,
  );
  const result = retrieveMemory(enriched, 'postgres hosting', { timeZone: TZ, now: NOW });
  assert.equal(result.items[0]?.id, 't3');
  assert.deepEqual(result.items[0]?.entities, ['Supabase', 'Neon', 'Railway']);
  assert.equal(result.items[0]?.claims.length, 1);
});

test('sinceDaysHint picks the smallest useful recency window', () => {
  const temporal = retrieveMemory(TURNS, 'since Monday', { timeZone: TZ, now: NOW }).temporal;
  assert.equal(sinceDaysHint(temporal.references, temporal.todayYmd), 2);
});

test('"last week" range recall includes turns inside the range', () => {
  const result = retrieveMemory(TURNS, 'what did we discuss last week?', { timeZone: TZ, now: NOW });
  assert.ok(result.dateScoped);
  const dates = result.items.map((i) => i.dateYmd);
  assert.ok(dates.includes('2026-11-04')); // Friday
  assert.ok(!dates.includes('2026-11-09')); // this Monday
});

test('content words like "pricing" rank the right same-day turn', () => {
  // Monday 9 Nov has two turns; the CRM one mentions pricing in question/answer.
  const mondayExtra = turn('Help me pick a team name', 'How about Aurora Borealis?', '2026-11-09T16:00:00Z');
  const all = [...TURNS, mondayExtra];
  const result = retrieveMemory(all, 'has any of them changed pricing since Monday?', {
    timeZone: TZ,
    now: NOW,
  });
  assert.ok(result.items.length >= 1);
  assert.match(result.items[0]?.question ?? '', /CRM/);
});
