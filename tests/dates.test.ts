import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTemporal, addDays, daysBetween, humanDate, getLocalParts, ymd } from '../src/memory/dates';

// Fixed "now": Wednesday, 11 November 2026, 13:05 UTC.
const NOW = new Date('2026-11-11T13:05:00Z');
const TZ = 'UTC';

function refs(query: string) {
  return resolveTemporal(query, TZ, NOW).references;
}

test('current date and weekday resolve in the given timezone', () => {
  const parts = getLocalParts(NOW, TZ);
  assert.equal(ymd(parts), '2026-11-11');
  assert.equal(parts.weekday, 3); // Wednesday
});

test('day-month parses without a year and resolves to the past', () => {
  const refs1 = refs('What did I ask you on 3 November?');
  assert.equal(refs1.length, 1);
  assert.deepEqual(refs1[0]?.dates, ['2026-11-03']);
  assert.equal(refs1[0]?.sinceDays, 8);
});

test('month-day order and ordinal suffixes parse', () => {
  assert.deepEqual(refs('November 3rd, was that correct?')[0]?.dates, ['2026-11-03']);
  assert.deepEqual(refs('what about the 21st of October')[0]?.dates, ['2026-10-21']);
  assert.deepEqual(refs('we spoke on October 21st 2025')[0]?.dates, ['2025-10-21']);
});

test('date without a year that is still in the future resolves to last year', () => {
  // Today is 11 Nov 2026, so "3 December" must mean 2025.
  assert.deepEqual(refs('since 3 December')[0]?.dates, ['2025-12-03']);
});

test('ISO dates parse directly', () => {
  assert.deepEqual(refs('since 2026-11-09 has anything changed?')[0]?.dates, ['2026-11-09']);
});

test('bare weekday resolves to the most recent occurrence (today allowed)', () => {
  // Wednesday -> "Monday" is 2 days ago.
  const r = refs('On Monday we shortlisted 5 CRM tools.');
  assert.equal(r.length, 1);
  assert.deepEqual(r[0]?.dates, ['2026-11-09']);
  assert.equal(r[0]?.sinceDays, 2);
});

test('"last Tuesday" returns both plausible Tuesdays, most recent first', () => {
  const r = refs('Last Tuesday I asked you about Postgres hosting.');
  assert.equal(r.length, 1);
  // Most recent Tuesday before Wed 11 Nov is Tue 10 Nov; previous week is Tue 3 Nov.
  assert.deepEqual(r[0]?.dates, ['2026-11-10', '2026-11-03']);
});

test('"last Monday" said on a Wednesday offers this week\'s and last week\'s Monday', () => {
  const r = refs('since last Monday');
  // Most recent Monday is 9 Nov (2 days ago); previous week's Monday is 2 Nov.
  assert.deepEqual(r[0]?.dates, ['2026-11-09', '2026-11-02']);
});

test('"last Monday" said on a Monday means 7 days back', () => {
  const monday = new Date('2026-11-09T10:00:00Z');
  const r = resolveTemporal('since last Monday', TZ, monday).references;
  assert.deepEqual(r[0]?.dates, ['2026-11-02', '2026-10-26']);
});

test('weekday said on its own day resolves to today', () => {
  const sunday = new Date('2026-11-08T10:00:00Z'); // Sunday, 8 Nov 2026
  const r = resolveTemporal('what did I ask on Sunday?', TZ, sunday).references;
  assert.deepEqual(r[0]?.dates, ['2026-11-08']);
});

test('"last week" produces a Monday-based range covering the previous week', () => {
  const r = refs('what did we discuss last week?');
  assert.equal(r.length, 1);
  assert.deepEqual(r[0]?.range, { from: '2026-11-02', to: '2026-11-08' });
});

test('yesterday and today resolve', () => {
  assert.deepEqual(refs('since yesterday')[0]?.dates, ['2026-11-10']);
  assert.deepEqual(refs('what did I ask today?')[0]?.dates, ['2026-11-11']);
});

test('timezones shift the local date', () => {
  // 11 Nov 2026 13:05 UTC is 12 Nov 02:05 in Sydney.
  const sydney = resolveTemporal('what did I ask yesterday?', 'Australia/Sydney', NOW);
  assert.equal(sydney.todayYmd, '2026-11-12');
  assert.deepEqual(sydney.references[0]?.dates, ['2026-11-11']);
});

test('no date reference yields an empty list', () => {
  assert.equal(refs('Compare Supabase and Neon pricing').length, 0);
});

test('date helpers behave', () => {
  assert.equal(addDays('2026-11-11', -2), '2026-11-09');
  assert.equal(addDays('2026-11-30', 1), '2026-12-01');
  assert.equal(daysBetween('2026-11-03', '2026-11-11'), 8);
  assert.equal(humanDate('2026-11-03'), 'Tue, 3 Nov 2026');
});
