import { Injectable } from '@nestjs/common';
import type { Tx } from '@elysium/db';
import {
  ZERO_CALLS,
  type CallCounts,
  type MissedCallFact,
  type StaffPeriod,
  type TimelineItem,
  type UnwrappedCallFact,
} from '@elysium/domain/staff-activity';

import * as staff from './staff.repository.js';

/**
 * Telephony's service interface for other modules (invariant 12; M57). The staff-activity module
 * reads each person's calls, talk time and wrap-ups through it (D-1006). No phone number, name or
 * recording crosses it: the timeline links to the call, which the Calls page shows under its own
 * permissions.
 */
export interface TelephonyApi {
  /** Each person's call counts for `[from, to)`, by user id. */
  staffCounts(tx: Tx, orgId: string, period: StaffPeriod): Promise<ReadonlyMap<string, CallCounts>>;

  /** Telephony's candidates for the mistake rules over `[from, to)`. */
  staffMistakeFacts(
    tx: Tx,
    orgId: string,
    period: StaffPeriod,
    wrapUpMinutes: number,
  ): Promise<{
    readonly missedCalls: readonly MissedCallFact[];
    readonly unwrappedCalls: readonly UnwrappedCallFact[];
  }>;

  /** Of `orderIds`, those an outbound call was linked to. */
  phonedOrders(tx: Tx, orgId: string, orderIds: readonly string[]): Promise<ReadonlySet<string>>;

  /** One person's calls for the timeline, newest first. */
  staffTimeline(
    tx: Tx,
    orgId: string,
    userId: string,
    period: StaffPeriod,
    limit: number,
  ): Promise<readonly TimelineItem[]>;
}

export const TELEPHONY_API = Symbol('TelephonyApi');

@Injectable()
export class TelephonyApiService implements TelephonyApi {
  async staffCounts(
    tx: Tx,
    orgId: string,
    period: StaffPeriod,
  ): Promise<ReadonlyMap<string, CallCounts>> {
    const counts = new Map<string, CallCounts>();
    const set = (userId: string, patch: Partial<CallCounts>) =>
      counts.set(userId, { ...(counts.get(userId) ?? ZERO_CALLS), ...patch });
    for (const row of await staff.callCounts(tx, orgId, period)) {
      set(row.user_id, {
        outbound: row.outbound,
        inbound: row.inbound,
        answered: row.answered,
        talkSeconds: row.talk_seconds,
      });
    }
    for (const row of await staff.missedCounts(tx, orgId, period))
      set(row.user_id, { missed: row.n });
    for (const row of await staff.wrapUpCounts(tx, orgId, period)) {
      set(row.user_id, { wrappedUp: row.n });
    }
    return counts;
  }

  async staffMistakeFacts(tx: Tx, orgId: string, period: StaffPeriod, wrapUpMinutes: number) {
    const missedCalls = (await staff.missedCalls(tx, orgId, period)).map((row): MissedCallFact => ({
      callId: row.call_id,
      userId: row.user_id,
      at: new Date(row.at),
    }));
    const unwrappedCalls = (await staff.lateWrapUps(tx, orgId, period, wrapUpMinutes)).map(
      (row): UnwrappedCallFact => ({
        callId: row.call_id,
        userId: row.user_id,
        endedAt: new Date(row.ended_at),
        wrappedUpAt: row.wrapped_up_at === null ? null : new Date(row.wrapped_up_at),
      }),
    );
    return { missedCalls, unwrappedCalls };
  }

  async phonedOrders(
    tx: Tx,
    orgId: string,
    orderIds: readonly string[],
  ): Promise<ReadonlySet<string>> {
    return new Set(await staff.phonedOrders(tx, orgId, orderIds));
  }

  async staffTimeline(
    tx: Tx,
    orgId: string,
    userId: string,
    period: StaffPeriod,
    limit: number,
  ): Promise<readonly TimelineItem[]> {
    return (await staff.timeline(tx, orgId, userId, period, limit)).map((row) => ({
      id: `calls:${row.id}`,
      at: new Date(row.at),
      desk: 'calls' as const,
      kind: row.direction === 'inbound' ? 'call.inbound' : 'call.outbound',
      ref: { type: 'call' as const, id: row.id, label: row.order_no },
      detail: {
        answered: row.answered ? 1 : 0,
        ...(row.talk_seconds === null ? {} : { talkSeconds: row.talk_seconds }),
      },
    }));
  }
}
