import type { MistakeFacts, StaffDesk, StaffRef } from './facts.js';
import type { PresenceSpan } from './presence.js';

/**
 * The mistake rules (M57, D-1002 to D-1004).
 *
 * Each rule reads the candidate facts the modules gathered and says which are mistakes, whose,
 * and how bad. A mistake is never stored: it is this function's answer, so a rule fixed later
 * applies to the past too. Its key (`kind:source id`) is stable, which is what an org admin's
 * review is stored against.
 *
 * The attribution (D-1003) puts a mistake on the person who could have prevented it, and only
 * when they could have:
 *
 * - a scan the station refused is the scanner's (caught, so low);
 * - a `wrong_item` return is the packer's: whoever completed the order's last packing;
 * - a `wrong_address` or `customer_unreachable` return is the confirmer's only when no call
 *   attempt before confirming reached the customer;
 * - a confirmation with no call attempt and no linked phone call is the confirmer's, when the
 *   brand requires a verification call;
 * - an order cancelled after confirming is the confirmer's (verification let it through);
 * - a call-back time passed by the grace with nobody calling is whoever set it, unless the order
 *   left the desk first;
 * - a customer's wait is the conversation's holder's, counted from when they held it, in working
 *   hours only; a wait from before the current holder took the conversation and after somebody
 *   else had it is nobody's (no assignment history to say whose);
 * - a missed inbound call is the extension holder's only while their presence was active;
 * - a call not wrapped up within the limit, an offer left to time out, and a packing completed
 *   without its required video are that person's.
 */

export const MISTAKE_KINDS = [
  'wrong_scan',
  'wrong_item_shipped',
  'address_not_verified',
  'confirmed_without_call',
  'cancelled_after_confirm',
  'call_back_missed',
  'slow_first_reply',
  'conversation_unanswered',
  'missed_call',
  'call_not_wrapped_up',
  'offer_timed_out',
  'packed_without_video',
] as const;
export type MistakeKind = (typeof MISTAKE_KINDS)[number];

export function isMistakeKind(value: string): value is MistakeKind {
  return (MISTAKE_KINDS as readonly string[]).includes(value);
}

export type MistakeSeverity = 'low' | 'medium' | 'high';

export const MISTAKE_SEVERITY: Readonly<Record<MistakeKind, MistakeSeverity>> = {
  wrong_scan: 'low',
  wrong_item_shipped: 'high',
  address_not_verified: 'high',
  confirmed_without_call: 'medium',
  cancelled_after_confirm: 'medium',
  call_back_missed: 'medium',
  slow_first_reply: 'medium',
  conversation_unanswered: 'high',
  missed_call: 'medium',
  call_not_wrapped_up: 'low',
  offer_timed_out: 'low',
  packed_without_video: 'medium',
};

export const MISTAKE_DESK: Readonly<Record<MistakeKind, StaffDesk>> = {
  wrong_scan: 'packing',
  wrong_item_shipped: 'packing',
  address_not_verified: 'orders',
  confirmed_without_call: 'orders',
  cancelled_after_confirm: 'orders',
  call_back_missed: 'orders',
  slow_first_reply: 'inbox',
  conversation_unanswered: 'inbox',
  missed_call: 'calls',
  call_not_wrapped_up: 'calls',
  offer_timed_out: 'orders',
  packed_without_video: 'packing',
};

export interface StaffActivitySettings {
  readonly callBackGraceMinutes: number;
  readonly firstReplyMinutes: number;
  readonly unansweredMinutes: number;
  readonly wrapUpMinutes: number;
  /** Minutes after Asia/Dhaka midnight. */
  readonly workdayStartMinute: number;
  readonly workdayEndMinute: number;
  readonly requireVerificationCall: boolean;
  readonly showColleagueNames: boolean;
  readonly mistakesReduceBonuses: boolean;
}

/** D-1004's defaults, and D-1000's and D-1001's switches. */
export const DEFAULT_STAFF_ACTIVITY_SETTINGS: StaffActivitySettings = {
  callBackGraceMinutes: 30,
  firstReplyMinutes: 15,
  unansweredMinutes: 60,
  wrapUpMinutes: 10,
  workdayStartMinute: 9 * 60,
  workdayEndMinute: 22 * 60,
  requireVerificationCall: true,
  showColleagueNames: true,
  mistakesReduceBonuses: false,
};

export interface Mistake {
  readonly key: string;
  readonly kind: MistakeKind;
  readonly severity: MistakeSeverity;
  readonly desk: StaffDesk;
  readonly userId: string;
  readonly at: Date;
  readonly ref: StaffRef;
  /** Small facts for the line: minutes waited, the scan's outcome, the return's reason. */
  readonly detail: Readonly<Record<string, string | number>>;
}

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const DHAKA_OFFSET_MS = 6 * 3_600_000;

/**
 * Milliseconds of `[start, end)` that fall inside the working day (Asia/Dhaka, every day of the
 * week: the desks work Fridays too; a brand that does not simply sees nothing to count).
 */
export function workingMsBetween(
  start: Date,
  end: Date,
  settings: Pick<StaffActivitySettings, 'workdayStartMinute' | 'workdayEndMinute'>,
): number {
  const from = start.getTime();
  const to = end.getTime();
  if (to <= from) return 0;
  let total = 0;
  // The Dhaka midnight at or before `from`.
  let day = Math.floor((from + DHAKA_OFFSET_MS) / DAY_MS) * DAY_MS - DHAKA_OFFSET_MS;
  for (; day < to; day += DAY_MS) {
    const open = day + settings.workdayStartMinute * MINUTE_MS;
    const close = day + settings.workdayEndMinute * MINUTE_MS;
    const overlap = Math.min(close, to) - Math.max(open, from);
    if (overlap > 0) total += overlap;
  }
  return total;
}

function activeAt(spans: readonly PresenceSpan[] | undefined, at: Date): boolean {
  if (spans === undefined) return false;
  const t = at.getTime();
  return spans.some(
    (span) =>
      span.state === 'active' && span.startedAt.getTime() <= t && span.endedAt.getTime() >= t,
  );
}

function make(
  kind: MistakeKind,
  sourceId: string,
  userId: string,
  at: Date,
  ref: StaffRef,
  detail: Record<string, string | number> = {},
): Mistake {
  return {
    key: `${kind}:${sourceId}`,
    kind,
    severity: MISTAKE_SEVERITY[kind],
    desk: MISTAKE_DESK[kind],
    userId,
    at,
    ref,
    detail,
  };
}

const orderRef = (id: string, orderNo: string): StaffRef => ({ type: 'order', id, label: orderNo });

export interface MistakeInput {
  readonly facts: MistakeFacts;
  readonly settings: StaffActivitySettings;
  /** Each person's presence spans over the period (for "while active"). */
  readonly spans: ReadonlyMap<string, readonly PresenceSpan[]>;
  /** The instant of asking: a wait or a wrap-up still open is measured to here. */
  readonly now: Date;
}

/** Every mistake the facts show, newest first, one per key. */
export function detectMistakes(input: MistakeInput): Mistake[] {
  const { facts, settings, spans, now } = input;
  const found = new Map<string, Mistake>();
  const add = (mistake: Mistake) => {
    if (!found.has(mistake.key)) found.set(mistake.key, mistake);
  };

  for (const scan of facts.wrongScans) {
    add(
      make(
        'wrong_scan',
        scan.scanId,
        scan.scannedBy,
        scan.at,
        orderRef(scan.orderId, scan.orderNo),
        {
          outcome: scan.outcome,
        },
      ),
    );
  }

  /** Who completed the order's last packing before `at` (a re-pack after the return is not it). */
  const packerBefore = (orderId: string, at: Date): string | undefined => {
    let found: { by: string; at: number } | undefined;
    for (const packer of facts.packers) {
      if (packer.orderId !== orderId) continue;
      const done = packer.completedAt.getTime();
      if (done > at.getTime()) continue;
      if (found === undefined || done > found.at) found = { by: packer.completedBy, at: done };
    }
    return found?.by;
  };

  for (const ret of facts.returns) {
    const ref = orderRef(ret.orderId, ret.orderNo);
    if (ret.reasonCode === 'wrong_item') {
      const packer = packerBefore(ret.orderId, ret.at);
      if (packer !== undefined) {
        add(
          make('wrong_item_shipped', ret.returnId, packer, ret.at, ref, { reason: ret.reasonCode }),
        );
      }
    } else if (
      (ret.reasonCode === 'wrong_address' || ret.reasonCode === 'customer_unreachable') &&
      ret.confirmedBy !== null &&
      ret.reachedBeforeConfirm === 0
    ) {
      add(
        make('address_not_verified', ret.returnId, ret.confirmedBy, ret.at, ref, {
          reason: ret.reasonCode,
        }),
      );
    }
  }

  if (settings.requireVerificationCall) {
    for (const confirmation of facts.confirmations) {
      if (confirmation.attemptsBeforeConfirm > 0) continue;
      if (facts.phonedOrders.has(confirmation.orderId)) continue;
      add(
        make(
          'confirmed_without_call',
          confirmation.orderId,
          confirmation.confirmedBy,
          confirmation.confirmedAt,
          orderRef(confirmation.orderId, confirmation.orderNo),
          { channel: confirmation.channel },
        ),
      );
    }
  }

  for (const cancel of facts.cancelsAfterConfirm) {
    add(
      make(
        'cancelled_after_confirm',
        cancel.orderId,
        cancel.confirmedBy,
        cancel.cancelledAt,
        orderRef(cancel.orderId, cancel.orderNo),
      ),
    );
  }

  const graceMs = settings.callBackGraceMinutes * MINUTE_MS;
  for (const callBack of facts.callBacks) {
    const due = callBack.callBackAt.getTime() + graceMs;
    if (callBack.settledAt !== null && callBack.settledAt.getTime() <= due) continue;
    const answeredAt = callBack.nextAttemptAt?.getTime() ?? now.getTime();
    if (answeredAt <= due) continue;
    add(
      make(
        'call_back_missed',
        callBack.attemptId,
        callBack.setBy,
        new Date(due),
        orderRef(callBack.orderId, callBack.orderNo),
        { lateMinutes: Math.floor((answeredAt - callBack.callBackAt.getTime()) / MINUTE_MS) },
      ),
    );
  }

  const slowMs = settings.firstReplyMinutes * MINUTE_MS;
  const unansweredMs = settings.unansweredMinutes * MINUTE_MS;
  for (const wait of facts.waits) {
    if (wait.holder === null || wait.heldSince === null) continue;
    const end = wait.repliedAt ?? now;
    // The holder took it after the wait was over: it was somebody else's then.
    if (wait.heldSince.getTime() >= end.getTime()) continue;
    const start = new Date(Math.max(wait.inboundAt.getTime(), wait.heldSince.getTime()));
    const waited = workingMsBetween(start, end, settings);
    const ref: StaffRef = { type: 'conversation', id: wait.conversationId, label: null };
    const minutes = Math.floor(waited / MINUTE_MS);
    if (waited > unansweredMs) {
      add(
        make('conversation_unanswered', wait.messageId, wait.holder, wait.inboundAt, ref, {
          minutes,
          replied: wait.repliedAt === null ? 0 : 1,
        }),
      );
    } else if (wait.repliedAt !== null && waited > slowMs) {
      add(make('slow_first_reply', wait.messageId, wait.holder, wait.inboundAt, ref, { minutes }));
    }
  }

  for (const call of facts.missedCalls) {
    if (!activeAt(spans.get(call.userId), call.at)) continue;
    add(
      make('missed_call', call.callId, call.userId, call.at, {
        type: 'call',
        id: call.callId,
        label: null,
      }),
    );
  }

  const wrapMs = settings.wrapUpMinutes * MINUTE_MS;
  for (const call of facts.unwrappedCalls) {
    const due = call.endedAt.getTime() + wrapMs;
    const done = call.wrappedUpAt?.getTime() ?? now.getTime();
    if (done <= due) continue;
    add(
      make(
        'call_not_wrapped_up',
        call.callId,
        call.userId,
        call.endedAt,
        {
          type: 'call',
          id: call.callId,
          label: null,
        },
        { wrapped: call.wrappedUpAt === null ? 0 : 1 },
      ),
    );
  }

  for (const offer of facts.expiredOffers) {
    add(make('offer_timed_out', offer.offerId, offer.userId, offer.expiredAt, offer.ref));
  }

  for (const session of facts.noVideo) {
    add(
      make(
        'packed_without_video',
        session.sessionId,
        session.completedBy,
        session.completedAt,
        orderRef(session.orderId, session.orderNo),
      ),
    );
  }

  return [...found.values()].sort(
    (a, b) => b.at.getTime() - a.at.getTime() || a.key.localeCompare(b.key),
  );
}

export type MistakeReviewStatus = 'confirmed' | 'dismissed';

export interface MistakeReview {
  readonly status: MistakeReviewStatus;
  readonly note: string | null;
  readonly reviewedBy: string;
  readonly reviewedAt: Date;
}

/**
 * The reviews that still apply (D-1017): a review is of a mistake **on the person it was
 * reviewed against**. A rule may put the same key on someone else later (a conversation handed
 * over, an extension given to another person); the old review then answers for nobody, and the
 * mistake reads as not reviewed, never as the new person's confirmed one.
 */
export function applicableReviews<R extends { readonly userId: string }>(
  mistakes: readonly Pick<Mistake, 'key' | 'userId'>[],
  reviews: ReadonlyMap<string, R>,
): Map<string, R> {
  const out = new Map<string, R>();
  for (const mistake of mistakes) {
    const review = reviews.get(mistake.key);
    if (review?.userId === mistake.userId && review !== undefined) out.set(mistake.key, review);
  }
  return out;
}

/** Whether a mistake counts in a person's figures: unreviewed and confirmed do (D-1002). */
export function mistakeCounts(review: MistakeReview | undefined): boolean {
  return review?.status !== 'dismissed';
}

/** Whether a mistake may cost a bonus: only an org admin's confirmed one (D-1001). */
export function mistakeCountsForPay(review: MistakeReview | undefined): boolean {
  return review?.status === 'confirmed';
}
