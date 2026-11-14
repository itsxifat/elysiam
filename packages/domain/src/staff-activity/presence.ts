import { PRESENCE_AWAY_AFTER_MS } from '../assignment/presence.js';
import { businessDate, type IsoDate } from '../dates/index.js';

/**
 * Presence history (M57, D-1005): the console's heartbeat (M41) folded into spans.
 *
 * `team.presence` keeps only the last report, so it can say who is here now but not how long
 * anybody was here yesterday. Each report now also extends the person's latest span, or opens
 * a new one:
 *
 * - **same state, within the away threshold**: the span's end moves to this report;
 * - **another state, within the threshold**: the old span stays where it ended, and the new one
 *   starts there, so the two touch and the time between the reports belongs to the new state;
 * - **after a longer gap** (the person was away: laptop shut, tab closed): a new span starts at
 *   this report, and the gap is offline time.
 *
 * A span's state is the stored word of M41 (`active` or `idle`) and the "Not taking orders"
 * switch. Paused is a flag, not a third state: a paused person may still be working, so
 * active + idle + offline is the whole period, and paused time is a part of online time.
 *
 * Asia/Dhaka is UTC+6 all year with no daylight saving, so a Dhaka hour starts on a UTC hour and
 * a Dhaka day at 18:00 UTC. The arithmetic below leans on that.
 */

export const PRESENCE_SPAN_STATES = ['active', 'idle'] as const;
export type PresenceSpanState = (typeof PRESENCE_SPAN_STATES)[number];

export interface PresenceSpan {
  readonly state: PresenceSpanState;
  readonly paused: boolean;
  readonly startedAt: Date;
  readonly endedAt: Date;
}

export interface StoredSpan extends PresenceSpan {
  readonly id: string;
}

export interface PresenceBeatFact {
  readonly state: PresenceSpanState;
  readonly paused: boolean;
  readonly at: Date;
}

export type SpanStep =
  | { readonly kind: 'extend'; readonly id: string; readonly endedAt: Date }
  | {
      readonly kind: 'open';
      readonly state: PresenceSpanState;
      readonly paused: boolean;
      readonly startedAt: Date;
      readonly endedAt: Date;
    }
  | { readonly kind: 'none' };

/**
 * What one report does to the person's latest span.
 *
 * A report at or before the latest span's end (two tabs, a clock that stepped back) changes
 * nothing: time already recorded is never recorded twice, which is what keeps one person's spans
 * from overlapping.
 */
export function spanStep(
  latest: StoredSpan | null,
  beat: PresenceBeatFact,
  awayAfterMs: number = PRESENCE_AWAY_AFTER_MS,
): SpanStep {
  const at = beat.at;
  if (latest === null) {
    return { kind: 'open', state: beat.state, paused: beat.paused, startedAt: at, endedAt: at };
  }
  const gap = at.getTime() - latest.endedAt.getTime();
  if (gap <= 0) return { kind: 'none' };
  if (gap > awayAfterMs) {
    return { kind: 'open', state: beat.state, paused: beat.paused, startedAt: at, endedAt: at };
  }
  if (latest.state === beat.state && latest.paused === beat.paused) {
    return { kind: 'extend', id: latest.id, endedAt: at };
  }
  return {
    kind: 'open',
    state: beat.state,
    paused: beat.paused,
    startedAt: latest.endedAt,
    endedAt: at,
  };
}

export interface PresenceTotals {
  readonly activeMs: number;
  readonly idleMs: number;
  /** Online time spent with "Not taking orders" on; part of active + idle. */
  readonly pausedMs: number;
  readonly onlineMs: number;
  readonly offlineMs: number;
  /** The first and last instant online within the period, or null. */
  readonly firstSeenAt: Date | null;
  readonly lastSeenAt: Date | null;
}

const EMPTY_TOTALS = {
  activeMs: 0,
  idleMs: 0,
  pausedMs: 0,
  onlineMs: 0,
  offlineMs: 0,
  firstSeenAt: null,
  lastSeenAt: null,
} as const satisfies PresenceTotals;

/**
 * Online, active, idle and paused time within `[from, to)`. Spans are clipped to the period.
 * The spans must not overlap (the heartbeat writer guarantees it; `assertNoOverlap` checks it).
 */
export function presenceTotals(
  spans: readonly PresenceSpan[],
  from: Date,
  to: Date,
): PresenceTotals {
  const periodMs = Math.max(0, to.getTime() - from.getTime());
  let activeMs = 0;
  let idleMs = 0;
  let pausedMs = 0;
  let first: number | null = null;
  let last: number | null = null;
  for (const span of spans) {
    const spanStart = span.startedAt.getTime();
    const spanEnd = span.endedAt.getTime();
    // Outside the period. A span ending exactly at `from` lies before it, unless it is a single
    // report (zero length) taken at that instant.
    if (spanStart >= to.getTime() || spanEnd < from.getTime()) continue;
    if (spanEnd === from.getTime() && spanEnd > spanStart) continue;
    const start = Math.max(spanStart, from.getTime());
    const end = Math.min(spanEnd, to.getTime());
    const ms = end - start;
    if (span.state === 'active') activeMs += ms;
    else idleMs += ms;
    if (span.paused) pausedMs += ms;
    first = first === null ? start : Math.min(first, start);
    last = last === null ? end : Math.max(last, end);
  }
  const onlineMs = activeMs + idleMs;
  return {
    activeMs,
    idleMs,
    pausedMs,
    onlineMs,
    offlineMs: periodMs - onlineMs,
    firstSeenAt: first === null ? null : new Date(first),
    lastSeenAt: last === null ? null : new Date(last),
  };
}

const HOUR_MS = 3_600_000;
const DHAKA_OFFSET_MS = 6 * HOUR_MS;
const DAY_MS = 24 * HOUR_MS;

/** The instant an Asia/Dhaka calendar date starts. */
export function dhakaDayStart(date: IsoDate): Date {
  return new Date(Date.parse(`${date}T00:00:00Z`) - DHAKA_OFFSET_MS);
}

/** Totals for each Asia/Dhaka date from `fromDate` to `toDate`, both included. */
export function presenceByDay(
  spans: readonly PresenceSpan[],
  fromDate: IsoDate,
  toDate: IsoDate,
): { readonly date: IsoDate; readonly totals: PresenceTotals }[] {
  const days: { date: IsoDate; totals: PresenceTotals }[] = [];
  const end = dhakaDayStart(toDate).getTime() + DAY_MS;
  for (let start = dhakaDayStart(fromDate).getTime(); start < end; start += DAY_MS) {
    const dayStart = new Date(start);
    const dayEnd = new Date(start + DAY_MS);
    const inDay = spans.filter((s) => s.endedAt > dayStart && s.startedAt < dayEnd);
    days.push({
      date: businessDate(dayStart),
      totals:
        inDay.length === 0
          ? { ...EMPTY_TOTALS, offlineMs: DAY_MS }
          : presenceTotals(inDay, dayStart, dayEnd),
    });
  }
  return days;
}

/**
 * Active minutes by Asia/Dhaka weekday (0 Sunday … 6 Saturday) and hour (0 … 23): the "when
 * do they work" heatmap. Whole minutes, rounded down per cell.
 */
export function activeHeatmap(spans: readonly PresenceSpan[]): number[][] {
  const ms: number[][] = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  for (const span of spans) {
    if (span.state !== 'active') continue;
    let at = span.startedAt.getTime();
    const end = span.endedAt.getTime();
    while (at < end) {
      const hourEnd = Math.floor(at / HOUR_MS) * HOUR_MS + HOUR_MS;
      const slice = Math.min(end, hourEnd) - at;
      const local = new Date(at + DHAKA_OFFSET_MS);
      const row = ms[local.getUTCDay()];
      if (row !== undefined) row[local.getUTCHours()] = (row[local.getUTCHours()] ?? 0) + slice;
      at += slice;
    }
  }
  return ms.map((row) => row.map((cell) => Math.floor(cell / 60_000)));
}

/** True when no two spans share any instant of positive length. */
export function spansOverlap(spans: readonly PresenceSpan[]): boolean {
  const sorted = [...spans].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  for (let i = 1; i < sorted.length; i += 1) {
    const previous = sorted[i - 1];
    const current = sorted[i];
    if (previous !== undefined && current !== undefined && current.startedAt < previous.endedAt) {
      return true;
    }
  }
  return false;
}
