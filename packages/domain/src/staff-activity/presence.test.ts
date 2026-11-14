import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { PRESENCE_AWAY_AFTER_MS } from '../assignment/presence.js';
import { toIsoDate } from '../dates/index.js';
import {
  activeHeatmap,
  dhakaDayStart,
  presenceByDay,
  presenceTotals,
  spanStep,
  spansOverlap,
  type PresenceBeatFact,
  type StoredSpan,
} from './presence.js';

/** Fold a stream of reports the way the heartbeat writer does, one step at a time. */
function fold(beats: readonly PresenceBeatFact[]): StoredSpan[] {
  const spans: StoredSpan[] = [];
  for (const beat of beats) {
    const latest = spans.at(-1) ?? null;
    const step = spanStep(latest, beat);
    if (step.kind === 'extend') {
      const index = spans.findIndex((span) => span.id === step.id);
      const span = spans[index];
      if (span !== undefined) spans[index] = { ...span, endedAt: step.endedAt };
    } else if (step.kind === 'open') {
      spans.push({ id: String(spans.length), ...step });
    }
  }
  return spans;
}

const T0 = Date.parse('2026-11-10T03:00:00Z'); // 09:00 in Dhaka
const at = (seconds: number) => new Date(T0 + seconds * 1000);

describe('spanStep', () => {
  it('opens the first span at the first report', () => {
    expect(spanStep(null, { state: 'active', paused: false, at: at(0) })).toEqual({
      kind: 'open',
      state: 'active',
      paused: false,
      startedAt: at(0),
      endedAt: at(0),
    });
  });

  it('extends a span with the same state within the away threshold', () => {
    const latest: StoredSpan = {
      id: 's',
      state: 'active',
      paused: false,
      startedAt: at(0),
      endedAt: at(30),
    };
    expect(spanStep(latest, { state: 'active', paused: false, at: at(60) })).toEqual({
      kind: 'extend',
      id: 's',
      endedAt: at(60),
    });
  });

  it('starts a touching span on a change of state, and a separate one after a gap', () => {
    const latest: StoredSpan = {
      id: 's',
      state: 'active',
      paused: false,
      startedAt: at(0),
      endedAt: at(30),
    };
    expect(spanStep(latest, { state: 'idle', paused: false, at: at(60) })).toMatchObject({
      kind: 'open',
      startedAt: at(30),
      endedAt: at(60),
    });
    expect(spanStep(latest, { state: 'active', paused: true, at: at(60) })).toMatchObject({
      kind: 'open',
      paused: true,
      startedAt: at(30),
    });
    const later = at(30 + PRESENCE_AWAY_AFTER_MS / 1000 + 1);
    expect(spanStep(latest, { state: 'active', paused: false, at: later })).toMatchObject({
      kind: 'open',
      startedAt: later,
      endedAt: later,
    });
  });

  it('ignores a report at or before the latest end', () => {
    const latest: StoredSpan = {
      id: 's',
      state: 'active',
      paused: false,
      startedAt: at(0),
      endedAt: at(30),
    };
    expect(spanStep(latest, { state: 'idle', paused: false, at: at(30) })).toEqual({
      kind: 'none',
    });
    expect(spanStep(latest, { state: 'idle', paused: false, at: at(10) })).toEqual({
      kind: 'none',
    });
  });
});

describe('presence hours (check 2)', () => {
  it('a working morning: active, idle, a pause, then a gap', () => {
    const beats: PresenceBeatFact[] = [];
    // 0 to 600 s active (21 reports), 630 to 900 idle, 930 to 1200 active and paused,
    // then nothing for ten minutes, then 1800 to 1860 active.
    for (let s = 0; s <= 600; s += 30) beats.push({ state: 'active', paused: false, at: at(s) });
    for (let s = 630; s <= 900; s += 30) beats.push({ state: 'idle', paused: false, at: at(s) });
    for (let s = 930; s <= 1200; s += 30) beats.push({ state: 'active', paused: true, at: at(s) });
    for (let s = 1800; s <= 1860; s += 30)
      beats.push({ state: 'active', paused: false, at: at(s) });
    const spans = fold(beats);
    expect(spans).toHaveLength(4);
    const totals = presenceTotals(spans, at(0), at(3600));
    // The paused span starts where the idle one ended (900 s), so it is 300 s long.
    expect(totals.activeMs).toBe((600 + 300 + 60) * 1000);
    expect(totals.idleMs).toBe(300 * 1000);
    expect(totals.pausedMs).toBe(300 * 1000);
    expect(totals.onlineMs).toBe(totals.activeMs + totals.idleMs);
    expect(totals.offlineMs).toBe(3600 * 1000 - totals.onlineMs);
    expect(totals.firstSeenAt).toEqual(at(0));
    expect(totals.lastSeenAt).toEqual(at(1860));
  });

  const beatStream = fc
    .array(
      fc.record({
        gapSeconds: fc.integer({ min: 1, max: 400 }),
        state: fc.constantFrom('active' as const, 'idle' as const),
        paused: fc.boolean(),
      }),
      { minLength: 1, maxLength: 120 },
    )
    .map((items) => {
      let seconds = 0;
      return items.map((item) => {
        seconds += item.gapSeconds;
        return { state: item.state, paused: item.paused, at: at(seconds) };
      });
    });

  it('spans never overlap, and active + idle + offline is the period exactly', () => {
    fc.assert(
      fc.property(
        beatStream,
        fc.integer({ min: 0, max: 20_000 }),
        fc.integer({ min: 1, max: 40_000 }),
        (beats, fromSeconds, lengthSeconds) => {
          const spans = fold(beats);
          expect(spansOverlap(spans)).toBe(false);
          const from = at(fromSeconds);
          const to = at(fromSeconds + lengthSeconds);
          const totals = presenceTotals(spans, from, to);
          expect(totals.activeMs + totals.idleMs + totals.offlineMs).toBe(lengthSeconds * 1000);
          expect(totals.offlineMs).toBeGreaterThanOrEqual(0);
          expect(totals.pausedMs).toBeLessThanOrEqual(totals.onlineMs);
        },
      ),
    );
  });

  it('a gap beyond the away threshold always ends a span', () => {
    fc.assert(
      fc.property(beatStream, (beats) => {
        const spans = fold(beats);
        for (let i = 1; i < beats.length; i += 1) {
          const previous = beats[i - 1];
          const current = beats[i];
          if (previous === undefined || current === undefined) continue;
          const gap = current.at.getTime() - previous.at.getTime();
          if (gap <= PRESENCE_AWAY_AFTER_MS) continue;
          // Nothing recorded strictly inside the gap.
          const covered = spans.some(
            (span) => span.startedAt < current.at && span.endedAt > previous.at,
          );
          expect(covered).toBe(false);
        }
      }),
    );
  });

  it('every reported instant is inside a span of the reported state', () => {
    fc.assert(
      fc.property(beatStream, (beats) => {
        const spans = fold(beats);
        for (const beat of beats) {
          // A report belongs to the span that runs up to it, or to the one it opened.
          const t = beat.at.getTime();
          const span =
            spans.find((s) => s.startedAt.getTime() < t && s.endedAt.getTime() >= t) ??
            spans.find((s) => s.startedAt.getTime() === t);
          expect(span?.state).toBe(beat.state);
          expect(span?.paused).toBe(beat.paused);
        }
      }),
    );
  });
});

describe('by day and heatmap', () => {
  it('splits a span across Dhaka midnight (18:00 UTC)', () => {
    const spans = [
      {
        state: 'active' as const,
        paused: false,
        startedAt: new Date('2026-11-10T17:30:00Z'), // 23:30 Dhaka
        endedAt: new Date('2026-11-10T18:45:00Z'), // 00:45 Dhaka on the 11th
      },
    ];
    const days = presenceByDay(spans, toIsoDate('2026-11-10'), toIsoDate('2026-11-11'));
    expect(days.map((d) => [d.date, d.totals.activeMs / 60_000])).toEqual([
      ['2026-11-10', 30],
      ['2026-11-11', 45],
    ]);
    expect(dhakaDayStart(toIsoDate('2026-11-11')).toISOString()).toBe('2026-11-10T18:00:00.000Z');
    const heat = activeHeatmap(spans);
    // 10 Nov 2026 is a Tuesday (2); 11 Nov a Wednesday (3).
    expect(heat[2]?.[23]).toBe(30);
    expect(heat[3]?.[0]).toBe(45);
    expect(heat.flat().reduce((a, b) => a + b, 0)).toBe(75);
  });

  it('an empty day is all offline', () => {
    const [day] = presenceByDay([], toIsoDate('2026-11-10'), toIsoDate('2026-11-10'));
    expect(day?.totals.offlineMs).toBe(86_400_000);
    expect(day?.totals.firstSeenAt).toBeNull();
  });
});
