import { describe, expect, it } from 'vitest';

import { NO_MISTAKE_FACTS, type MistakeFacts } from './facts.js';
import {
  DEFAULT_STAFF_ACTIVITY_SETTINGS,
  applicableReviews,
  detectMistakes,
  mistakeCounts,
  mistakeCountsForPay,
  workingMsBetween,
  type StaffActivitySettings,
} from './mistakes.js';
import type { PresenceSpan } from './presence.js';

/** 2026-11-10 at hh:mm in Asia/Dhaka (UTC+6). */
const dhaka = (hhmm: string, day = 10) =>
  new Date(`2026-11-${String(day).padStart(2, '0')}T${hhmm}:00+06:00`);
const NOW = dhaka('21:00');

function run(
  facts: Partial<MistakeFacts>,
  options: {
    settings?: Partial<StaffActivitySettings>;
    spans?: Map<string, PresenceSpan[]>;
    now?: Date;
  } = {},
) {
  return detectMistakes({
    facts: { ...NO_MISTAKE_FACTS, ...facts },
    settings: { ...DEFAULT_STAFF_ACTIVITY_SETTINGS, ...options.settings },
    spans: options.spans ?? new Map(),
    now: options.now ?? NOW,
  });
}

const summary = (mistakes: ReturnType<typeof run>) =>
  mistakes.map((m) => [m.kind, m.userId, m.key]);

describe('workingMsBetween', () => {
  const hours = { workdayStartMinute: 9 * 60, workdayEndMinute: 22 * 60 };
  it.each([
    ['inside the day', dhaka('10:00'), dhaka('10:30'), 30],
    ['starting before opening', dhaka('08:00'), dhaka('09:20'), 20],
    ['across closing and the night', dhaka('21:50'), dhaka('09:10', 11), 20],
    ['all night', dhaka('22:00'), dhaka('09:00', 11), 0],
    ['backwards', dhaka('11:00'), dhaka('10:00'), 0],
    ['two whole days', dhaka('00:00'), dhaka('00:00', 12), 2 * 13 * 60],
  ])('%s', (_, start, end, minutes) => {
    expect(workingMsBetween(start, end, hours)).toBe(minutes * 60_000);
  });
});

describe('detectMistakes: one table per rule (check 3)', () => {
  it('a refused scan is the scanner’s, low', () => {
    const [mistake] = run({
      wrongScans: [
        {
          scanId: 's1',
          sessionId: 'p1',
          orderId: 'o1',
          orderNo: 'ELY-1',
          scannedBy: 'packer',
          at: dhaka('11:00'),
          outcome: 'wrong_variant',
        },
      ],
    });
    expect(mistake).toMatchObject({
      key: 'wrong_scan:s1',
      userId: 'packer',
      severity: 'low',
      desk: 'packing',
      ref: { type: 'order', id: 'o1', label: 'ELY-1' },
      detail: { outcome: 'wrong_variant' },
    });
  });

  it.each([
    [
      'wrong_item, packed twice: the last packer',
      'wrong_item',
      null,
      0,
      [['wrong_item_shipped', 'second-packer', 'wrong_item_shipped:r1']],
    ],
    [
      'wrong_address, no call reached: the confirmer',
      'wrong_address',
      'agent',
      0,
      [['address_not_verified', 'agent', 'address_not_verified:r1']],
    ],
    [
      'customer_unreachable, no call reached: the confirmer',
      'customer_unreachable',
      'agent',
      0,
      [['address_not_verified', 'agent', 'address_not_verified:r1']],
    ],
    ['wrong_address after a call reached them: nobody', 'wrong_address', 'agent', 1, []],
    ['wrong_address, confirmed by the system: nobody', 'wrong_address', null, 0, []],
    ['changed_mind: nobody', 'changed_mind', 'agent', 0, []],
  ])('%s', (_, reasonCode, confirmedBy, reached, expected) => {
    const mistakes = run({
      returns: [
        {
          returnId: 'r1',
          orderId: 'o1',
          orderNo: 'ELY-1',
          reasonCode,
          at: dhaka('12:00'),
          confirmedBy,
          reachedBeforeConfirm: reached,
        },
      ],
      packers: [
        {
          orderId: 'o1',
          sessionId: 'p2',
          completedBy: 'second-packer',
          completedAt: dhaka('10:00'),
        },
        {
          orderId: 'o1',
          sessionId: 'p1',
          completedBy: 'first-packer',
          completedAt: dhaka('09:30'),
        },
      ],
    });
    expect(summary(mistakes)).toEqual(expected);
  });

  it('a wrong_item return with no packing on record blames nobody', () => {
    const mistakes = run({
      returns: [
        {
          returnId: 'r1',
          orderId: 'o9',
          orderNo: 'ELY-9',
          reasonCode: 'wrong_item',
          at: dhaka('12:00'),
          confirmedBy: 'agent',
          reachedBeforeConfirm: 0,
        },
      ],
    });
    expect(mistakes).toEqual([]);
  });

  it.each([
    ['no attempt, no phone call', 0, false, true, 1],
    ['an attempt (any outcome)', 1, false, true, 0],
    ['a linked Envo call', 0, true, true, 0],
    ['the brand does not require a call', 0, false, false, 0],
  ])('confirmed without a call: %s', (_, attempts, phoned, required, count) => {
    const mistakes = run(
      {
        confirmations: [
          {
            orderId: 'o1',
            orderNo: 'ELY-1',
            confirmedBy: 'agent',
            confirmedAt: dhaka('10:00'),
            attemptsBeforeConfirm: attempts,
            channel: 'facebook',
          },
        ],
        phonedOrders: new Set(phoned ? ['o1'] : []),
      },
      { settings: { requireVerificationCall: required } },
    );
    expect(mistakes.filter((m) => m.kind === 'confirmed_without_call')).toHaveLength(count);
  });

  it('a cancel after confirming is the confirmer’s, whoever cancelled', () => {
    const [mistake] = run({
      cancelsAfterConfirm: [
        {
          orderId: 'o1',
          orderNo: 'ELY-1',
          confirmedBy: 'agent',
          cancelledAt: dhaka('15:00'),
          cancelledBy: 'admin',
        },
      ],
    });
    expect(mistake).toMatchObject({ kind: 'cancelled_after_confirm', userId: 'agent' });
  });

  it.each([
    ['called back on time', dhaka('14:20'), null, 0],
    ['called back late', dhaka('15:00'), null, 1],
    ['never called back, now past due', null, null, 1],
    ['the order was confirmed before it fell due', null, dhaka('13:00'), 0],
    ['confirmed only after it fell due', null, dhaka('17:00'), 1],
  ])('call-back (due 14:00, 30 min grace): %s', (_, next, settled, count) => {
    const mistakes = run({
      callBacks: [
        {
          attemptId: 'a1',
          orderId: 'o1',
          orderNo: 'ELY-1',
          setBy: 'agent',
          callBackAt: dhaka('14:00'),
          nextAttemptAt: next,
          settledAt: settled,
        },
      ],
    });
    expect(mistakes.filter((m) => m.kind === 'call_back_missed')).toHaveLength(count);
    if (count === 1) expect(mistakes[0]?.userId).toBe('agent');
  });

  it('a reassigned order: the call-back is still whoever promised it, confirmed by another', () => {
    // Agent A promised a call at 14:00; the order was handed to B, who called at 15:00 and
    // confirmed with no further attempt of their own: the missed call-back is A's, and B's
    // confirmation (after A's attempt) is no "confirmed without a call".
    const mistakes = run({
      callBacks: [
        {
          attemptId: 'a1',
          orderId: 'o1',
          orderNo: 'ELY-1',
          setBy: 'agent-a',
          callBackAt: dhaka('14:00'),
          nextAttemptAt: dhaka('15:00'),
          settledAt: dhaka('15:05'),
        },
      ],
      confirmations: [
        {
          orderId: 'o1',
          orderNo: 'ELY-1',
          confirmedBy: 'agent-b',
          confirmedAt: dhaka('15:05'),
          attemptsBeforeConfirm: 2,
          channel: 'facebook',
        },
      ],
    });
    expect(summary(mistakes)).toEqual([['call_back_missed', 'agent-a', 'call_back_missed:a1']]);
  });

  it('a call-back not yet due is no mistake', () => {
    const mistakes = run(
      {
        callBacks: [
          {
            attemptId: 'a1',
            orderId: 'o1',
            orderNo: 'ELY-1',
            setBy: 'agent',
            callBackAt: dhaka('20:50'),
            nextAttemptAt: null,
            settledAt: null,
          },
        ],
      },
      { now: dhaka('21:00') },
    );
    expect(mistakes).toEqual([]);
  });

  describe('a customer waiting (15 min slow, 60 min unanswered, 09:00–22:00)', () => {
    const wait = {
      conversationId: 'c1',
      messageId: 'm1',
      inboundAt: dhaka('10:00'),
      holder: 'agent' as string | null,
      heldSince: dhaka('09:00') as Date | null,
      repliedAt: dhaka('10:10') as Date | null,
      repliedBy: 'agent' as string | null,
    };
    it.each([
      ['answered in 10 minutes', {}, []],
      ['answered in 20 minutes', { repliedAt: dhaka('10:20') }, [['slow_first_reply', 'agent']]],
      [
        'answered in 90 minutes',
        { repliedAt: dhaka('11:30') },
        [['conversation_unanswered', 'agent']],
      ],
      [
        'not answered, 11 hours on',
        { repliedAt: null, repliedBy: null },
        [['conversation_unanswered', 'agent']],
      ],
      [
        'asked at 21:55, answered at 09:05 next day: 10 working minutes',
        { inboundAt: dhaka('21:55'), repliedAt: dhaka('09:05', 11) },
        [],
      ],
      ['held by nobody', { holder: null, heldSince: null, repliedAt: null, repliedBy: null }, []],
      [
        'handed over: the new holder took it at 10:50, answered 10:55',
        { heldSince: dhaka('10:50'), repliedAt: dhaka('10:55') },
        [],
      ],
      [
        'handed over: the new holder took it at 10:50, answered 11:30 (40 of theirs)',
        { heldSince: dhaka('10:50'), repliedAt: dhaka('11:30') },
        [['slow_first_reply', 'agent']],
      ],
      [
        'taken by the current holder after the reply: it was not theirs',
        { heldSince: dhaka('12:00'), repliedAt: dhaka('11:30') },
        [],
      ],
    ])('%s', (_, change, expected) => {
      const mistakes = run({ waits: [{ ...wait, ...change }] });
      expect(mistakes.map((m) => [m.kind, m.userId])).toEqual(expected);
    });
  });

  it('a missed call is the holder’s only while they were active', () => {
    const spans = new Map<string, PresenceSpan[]>([
      [
        'here',
        [{ state: 'active', paused: false, startedAt: dhaka('10:00'), endedAt: dhaka('11:00') }],
      ],
      [
        'dozing',
        [{ state: 'idle', paused: false, startedAt: dhaka('10:00'), endedAt: dhaka('11:00') }],
      ],
    ]);
    const mistakes = run(
      {
        missedCalls: [
          { callId: 'k1', userId: 'here', at: dhaka('10:30') },
          { callId: 'k2', userId: 'dozing', at: dhaka('10:30') },
          { callId: 'k3', userId: 'gone', at: dhaka('10:30') },
          { callId: 'k4', userId: 'here', at: dhaka('11:30') },
        ],
      },
      { spans },
    );
    expect(summary(mistakes)).toEqual([['missed_call', 'here', 'missed_call:k1']]);
  });

  it.each([
    ['wrapped up in 5 minutes', dhaka('10:05'), 0],
    ['wrapped up in 20 minutes', dhaka('10:20'), 1],
    ['never, and it is past the limit', null, 1],
  ])('wrap-up (10 min): %s', (_, wrappedUpAt, count) => {
    const mistakes = run({
      unwrappedCalls: [{ callId: 'k1', userId: 'agent', endedAt: dhaka('10:00'), wrappedUpAt }],
    });
    expect(mistakes).toHaveLength(count);
  });

  it('an offer left to time out and a packing without its video', () => {
    const mistakes = run({
      expiredOffers: [
        {
          offerId: 'f1',
          ref: { type: 'order', id: 'o1', label: 'ELY-1' },
          userId: 'agent',
          expiredAt: dhaka('10:00'),
        },
      ],
      noVideo: [
        {
          sessionId: 'p1',
          orderId: 'o2',
          orderNo: 'ELY-2',
          completedBy: 'packer',
          completedAt: dhaka('11:00'),
        },
      ],
    });
    expect(summary(mistakes)).toEqual([
      ['packed_without_video', 'packer', 'packed_without_video:p1'],
      ['offer_timed_out', 'agent', 'offer_timed_out:f1'],
    ]);
  });

  it('gives each key once, newest first', () => {
    const scan = {
      scanId: 's1',
      sessionId: 'p1',
      orderId: 'o1',
      orderNo: 'ELY-1',
      scannedBy: 'packer',
      at: dhaka('11:00'),
      outcome: 'over' as const,
    };
    const mistakes = run({
      wrongScans: [scan, scan, { ...scan, scanId: 's2', at: dhaka('12:00') }],
    });
    expect(mistakes.map((m) => m.key)).toEqual(['wrong_scan:s2', 'wrong_scan:s1']);
  });
});

describe('reviews', () => {
  const review = (status: 'confirmed' | 'dismissed') => ({
    status,
    note: null,
    reviewedBy: 'admin',
    reviewedAt: NOW,
  });
  it('unreviewed and confirmed count; dismissed does not', () => {
    expect(mistakeCounts(undefined)).toBe(true);
    expect(mistakeCounts(review('confirmed'))).toBe(true);
    expect(mistakeCounts(review('dismissed'))).toBe(false);
  });
  it('only a confirmed mistake counts for pay', () => {
    expect(mistakeCountsForPay(undefined)).toBe(false);
    expect(mistakeCountsForPay(review('confirmed'))).toBe(true);
    expect(mistakeCountsForPay(review('dismissed'))).toBe(false);
  });
});

describe('the ledger audit’s cases', () => {
  it('a review answers only for the person it was made against (D-1017)', () => {
    const review = (userId: string) => ({ userId, status: 'confirmed' as const });
    const reviews = new Map([
      ['k1', review('agent-a')],
      ['k2', review('agent-a')],
    ]);
    const applied = applicableReviews(
      [
        { key: 'k1', userId: 'agent-a' },
        // The conversation was handed to B: the same key is now B's, the review is not.
        { key: 'k2', userId: 'agent-b' },
      ],
      reviews,
    );
    expect([...applied.keys()]).toEqual(['k1']);
  });

  it('a wrong_item return is the packer’s before it came back, not a re-pack after', () => {
    const [mistake] = run({
      returns: [
        {
          returnId: 'r1',
          orderId: 'o1',
          orderNo: 'ELY-1',
          reasonCode: 'wrong_item',
          at: dhaka('12:00'),
          confirmedBy: 'agent',
          reachedBeforeConfirm: 1,
        },
      ],
      packers: [
        {
          orderId: 'o1',
          sessionId: 'p1',
          completedBy: 'first-packer',
          completedAt: dhaka('09:30'),
        },
        { orderId: 'o1', sessionId: 'p2', completedBy: 're-packer', completedAt: dhaka('15:00') },
      ],
    });
    expect(mistake).toMatchObject({ kind: 'wrong_item_shipped', userId: 'first-packer' });
  });
});
