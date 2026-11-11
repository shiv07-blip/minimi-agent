/**
 * Local-calendar date math without a timezone library.
 *
 * Strategy: `Intl.DateTimeFormat(timeZone)` converts any instant into local
 * Y/M/D/H/M parts; all calendar arithmetic (adding days, finding weekdays)
 * then happens on plain UTC dates built from those parts, which is safe
 * because we only ever compare calendar dates, never instants.
 */

export interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number;
  minute: number;
  second: number;
  weekday: number; // 0 = Sunday ... 6 = Saturday
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    const opts: Intl.DateTimeFormatOptions = {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    };
    try {
      fmt = new Intl.DateTimeFormat('en-GB', opts);
    } catch {
      fmt = new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: 'UTC' });
    }
    formatters.set(timeZone, fmt);
  }
  return fmt;
}

export function getLocalParts(date: Date, timeZone: string): LocalParts {
  const parts = formatter(timeZone).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const year = get('year');
  const month = get('month');
  const day = get('day');
  return {
    year,
    month,
    day,
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
    weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
  };
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const pad = (n: number) => String(n).padStart(2, '0');
export const ymd = (p: { year: number; month: number; day: number }) => `${p.year}-${pad(p.month)}-${pad(p.day)}`;
export const ymdNum = (s: string) => Number(s.replaceAll('-', ''));

export function todayYmd(timeZone: string, now = new Date()): string {
  return ymd(getLocalParts(now, timeZone));
}

/** Convert `YYYY-MM-DD` to a UTC-anchored Date for day arithmetic. */
function ymdToDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y as number, (m ?? 1) - 1, d ?? 1));
}

function dateToYmd(date: Date): string {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

export function addDays(inputYmd: string, days: number): string {
  const date = ymdToDate(inputYmd);
  date.setUTCDate(date.getUTCDate() + days);
  return dateToYmd(date);
}

export function daysBetween(fromYmd: string, toYmd: string): number {
  return Math.round((ymdToDate(toYmd).getTime() - ymdToDate(fromYmd).getTime()) / 86_400_000);
}

export function weekdayOfYmd(inputYmd: string): number {
  return ymdToDate(inputYmd).getUTCDay();
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** Human label like "Mon, 9 Nov 2026" (keeps prompts and answers readable). */
export function humanDate(inputYmd: string, style: 'long' | 'short' = 'short'): string {
  const date = ymdToDate(inputYmd);
  const dayName = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getUTCDay()];
  const monthName = MONTH_NAMES[date.getUTCMonth()] ?? '';
  if (style === 'long') return `${dayName}, ${date.getUTCDate()} ${monthName} ${date.getUTCFullYear()}`;
  return `${dayName}, ${date.getUTCDate()} ${monthName.slice(0, 3)} ${date.getUTCFullYear()}`;
}

export function formatHumanNow(timeZone: string, now = new Date()): string {
  const p = getLocalParts(now, timeZone);
  const dayName = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][p.weekday] ?? '';
  return `${dayName}, ${p.day} ${MONTH_NAMES[p.month - 1]} ${p.year} at ${pad(p.hour)}:${pad(p.minute)} (${timeZone})`;
}

/* ------------------------------------------------------------------ */
/* Temporal expression parsing                                         */
/* ------------------------------------------------------------------ */

const MONTH_LOOKUP: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

const WEEKDAY_LOOKUP: Record<string, number> = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tues: 2, tue: 2, wednesday: 3, weds: 3, wed: 3,
  thursday: 4, thurs: 4, thu: 4, friday: 5, fri: 5, saturday: 6, sat: 6,
};

const WEEKDAY_WORD = new RegExp(`\\b(sunday|sun|monday|mon|tuesday|tues|tue|wednesday|weds|wed|thursday|thurs|thu|friday|fri|saturday|sat)\\b`, 'gi');

export interface TemporalReference {
  /** The matched phrase, e.g. "last Tuesday". */
  phrase: string;
  /** Candidate days `YYYY-MM-DD`, most likely first. */
  dates: string[];
  /** Optional inclusive range (for "last week"). */
  range?: { from: string; to: string };
  /** Positive when the phrase marks a "since" boundary (days ago). */
  sinceDays?: number;
  /** Brief disambiguation note for the model. */
  note?: string;
}

export interface TemporalContext {
  timeZone: string;
  nowIso: string;
  todayYmd: string;
  humanNow: string;
  references: TemporalReference[];
}

interface Span {
  start: number;
  end: number;
}

function overlaps(spans: Span[], span: Span): boolean {
  return spans.some((s) => span.start < s.end && s.start < span.end);
}

/**
 * Resolve date references in a user query.
 *
 * Ambiguity is handled by returning *candidates*, ordered by likelihood:
 * "last Tuesday" on a Wednesday yields both yesterday and the previous week's
 * Tuesday. Retrieval then picks whichever candidate actually has a matching
 * memory, which is far more robust than guessing one interpretation.
 */
export function resolveTemporal(query: string, timeZone: string, now = new Date()): TemporalContext {
  const local = getLocalParts(now, timeZone);
  const today = ymd(local);
  const refs: TemporalReference[] = [];
  const spans: Span[] = [];

  const commit = (span: Span, ref: TemporalReference) => {
    if (overlaps(spans, span)) return;
    spans.push(span);
    refs.push(ref);
  };

  const sinceDaysFor = (dateYmd: string): number | undefined => {
    const diff = daysBetween(dateYmd, today);
    return diff > 0 ? diff : undefined;
  };

  /* 1. Explicit ISO dates: 2026-11-03 */
  for (const match of query.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    const date = `${match[1]}-${match[2]}-${match[3]}`;
    const start = match.index ?? 0;
    commit({ start, end: start + match[0].length }, {
      phrase: match[0],
      dates: [date],
      sinceDays: sinceDaysFor(date),
    });
  }

  /* 2. "3 November" / "3rd Nov" / "November 3rd, 2026" (year optional) */
  const withYearFor = (month: number, day: number, year?: number): string[] => {
    if (year) return [`${year}-${pad(month)}-${pad(day)}`];
    const thisYear = `${local.year}-${pad(month)}-${pad(day)}`;
    // Without a year, "3 November" almost certainly refers to the past.
    if (ymdNum(thisYear) > ymdNum(today)) return [`${local.year - 1}-${pad(month)}-${pad(day)}`];
    return [thisYear];
  };

  for (const match of query.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?(?:,?\s*(\d{4}))?\b/gi)) {
    const day = Number(match[1]);
    const month = MONTH_LOOKUP[(match[2] ?? '').toLowerCase()] ?? 0;
    const year = match[3] ? Number(match[3]) : undefined;
    if (!month || day < 1 || day > 31) continue;
    const dates = withYearFor(month, day, year);
    const start = match.index ?? 0;
    commit({ start, end: start + match[0].length }, {
      phrase: match[0].trim(),
      dates,
      sinceDays: sinceDaysFor(dates[0] ?? ''),
    });
  }

  for (const match of query.matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?\b/gi)) {
    const month = MONTH_LOOKUP[(match[1] ?? '').toLowerCase()] ?? 0;
    const day = Number(match[2]);
    const year = match[3] ? Number(match[3]) : undefined;
    if (!month || day < 1 || day > 31) continue;
    const dates = withYearFor(month, day, year);
    const start = match.index ?? 0;
    commit({ start, end: start + match[0].length }, {
      phrase: match[0].trim(),
      dates,
      sinceDays: sinceDaysFor(dates[0] ?? ''),
    });
  }

  /* 3. Bare relative words: yesterday / today / tomorrow */
  const relativeOffsets: Record<string, number> = { yesterday: -1, today: 0, tonight: 0, tomorrow: 1 };
  for (const [word, offset] of Object.entries(relativeOffsets)) {
    const match = new RegExp(`\\b${word}\\b`, 'i').exec(query);
    if (!match) continue;
    const date = addDays(today, offset);
    const start = match.index ?? 0;
    commit({ start, end: start + match[0].length }, {
      phrase: match[0],
      dates: [date],
      sinceDays: offset < 0 ? -offset : undefined,
    });
  }

  /* 4. Week / month ranges */
  const weekRange = (label: string, startOffset: number): void => {
    const match = new RegExp(`\\b${label}\\b`, 'i').exec(query);
    if (!match) return;
    // Monday-based weeks.
    const mondayOffsetFromToday = (local.weekday + 6) % 7;
    const monday = addDays(today, -mondayOffsetFromToday + startOffset);
    const range = { from: monday, to: addDays(monday, 6) };
    const start = match.index ?? 0;
    commit({ start, end: start + match[0].length }, {
      phrase: match[0],
      dates: [],
      range,
      sinceDays: Math.max(1, daysBetween(monday, today)),
    });
  };
  weekRange('last week', -7);
  weekRange('this week', 0);
  weekRange('past week', -6);
  weekRange('past 7 days', -6);

  const monthRange = (label: string, monthsBack: number): void => {
    const match = new RegExp(`\\b${label}\\b`, 'i').exec(query);
    if (!match) return;
    const monthDate = new Date(Date.UTC(local.year, local.month - 1 - monthsBack, 1));
    const range = {
      from: `${monthDate.getUTCFullYear()}-${pad(monthDate.getUTCMonth() + 1)}-01`,
      to: dateToYmd(new Date(Date.UTC(monthDate.getUTCFullYear(), monthDate.getUTCMonth() + 1, 0))),
    };
    const start = match.index ?? 0;
    commit({ start, end: start + match[0].length }, { phrase: match[0], dates: [], range });
  };
  monthRange('last month', 1);
  monthRange('this month', 0);

  /* 5. Weekdays: "on Monday", "last Tuesday", "this Friday", "since Thursday" */
  for (const match of query.matchAll(/\b(on|last|this|past|next|since)\s+(sunday|sun|monday|mon|tuesday|tues|tue|wednesday|weds|wed|thursday|thurs|thu|friday|fri|saturday|sat)\b/gi)) {
    const modifier = (match[1] ?? '').toLowerCase();
    const target = WEEKDAY_LOOKUP[(match[2] ?? '').toLowerCase()] ?? 0;
    let back = (local.weekday - target + 7) % 7; // days since that weekday
    if (modifier === 'last' && back === 0) back = 7; // "last Monday" said on a Monday
    if (modifier === 'next') back = back - 7; // future occurrence
    const mostRecent = addDays(today, -back);

    let dates: string[] = [];
    let note: string | undefined;
    if (modifier === 'last') {
      // "last Tuesday" is ambiguous (most recent occurrence vs previous week's
      // Tuesday). Offer both candidates; memory retrieval disambiguates.
      const previousWeek = addDays(mostRecent, -7);
      dates = previousWeek === mostRecent ? [mostRecent] : [mostRecent, previousWeek];
      note = 'ambiguous: most recent occurrence first, then the previous week';
    } else if (modifier === 'next') {
      dates = [mostRecent];
    } else {
      dates = [mostRecent];
      if (back === 0) note = 'today';
    }

    const start = match.index ?? 0;
    commit({ start, end: start + match[0].length }, {
      phrase: match[0],
      dates,
      sinceDays: back > 0 ? back : undefined,
      note,
    });
  }

  /* 6. Bare weekday mentions not already consumed ("we met Monday") */
  for (const match of query.matchAll(WEEKDAY_WORD)) {
    const start = match.index ?? 0;
    const span = { start, end: start + match[0].length };
    if (overlaps(spans, span)) continue;
    const target = WEEKDAY_LOOKUP[(match[0] ?? '').toLowerCase()] ?? 0;
    const back = (local.weekday - target + 7) % 7;
    const date = addDays(today, -back);
    commit(span, {
      phrase: match[0],
      dates: [date],
      sinceDays: back > 0 ? back : undefined,
      note: back === 0 ? 'today' : undefined,
    });
  }

  return {
    timeZone,
    nowIso: now.toISOString(),
    todayYmd: today,
    humanNow: formatHumanNow(timeZone, now),
    references: refs,
  };
}
