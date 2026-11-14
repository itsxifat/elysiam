import { withOrg, withSystem } from '@elysium/db';
import { presenceTotals, spansOverlap } from '@elysium/domain/staff-activity';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ORG_A,
  ORG_B,
  startHttpHarness,
  type HttpHarness,
  type RoleClient,
} from '../../testing/http-harness.js';
import { PresenceHistoryService } from './presence-history.service.js';
import { TEAM_API, type TeamApi } from './team.api.js';

/**
 * M57 check 2, on real PostgreSQL: the heartbeat over HTTP keeps a presence history.
 *
 * The fold itself (`spanStep`) has its property tests in the domain; here the reports arrive
 * through `POST /v1/team/presence` and `/pause` with the database's own clock, and the spans
 * are read back through `TeamApi.presenceSpans`, the staff-activity module's only way in.
 */

let harness: HttpHarness;
let team: TeamApi;

beforeAll(async () => {
  process.env.LOG_LEVEL = 'fatal';
  harness = await startHttpHarness('presence-spans');
  team = harness.app.get<TeamApi>(TEAM_API);
}, 420_000);

afterAll(async () => {
  await harness?.close();
}, 60_000);

interface SpanRow extends Record<string, unknown> {
  id: string;
  state: string;
  paused: boolean;
  started_at: Date | string;
  ended_at: Date | string;
}

interface Span {
  id: string;
  state: string;
  paused: boolean;
  started_at: Date;
  ended_at: Date;
}

/** The database's message under drizzle's "Failed query" wrapper. */
async function refusal(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    const cause = (error as { cause?: { message?: string } }).cause;
    return cause?.message ?? String(error);
  }
  return 'not refused';
}

async function spansOf(userId: string, orgId = ORG_A): Promise<Span[]> {
  const rows = await withSystem(
    async (tx) => [
      ...(await tx.execute<SpanRow>(sql`
        select id, state, paused, started_at, ended_at from team.presence_spans
        where org_id = ${orgId} and user_id = ${userId} order by started_at, ended_at
      `)),
    ],
    { orgId },
  );
  return rows.map((row) => ({
    ...row,
    started_at: new Date(row.started_at),
    ended_at: new Date(row.ended_at),
  }));
}

async function beat(actor: RoleClient, input: { visible: boolean; idleSeconds: number }) {
  const response = await actor.client.request('POST', '/v1/team/presence', { body: input });
  expect(response.statusCode).toBe(201);
}

describe('presence history (M57 check 2)', () => {
  it('extends one span while the state holds, and starts a touching one on a change', async () => {
    const actor = await harness.asRole('sales', ORG_A);
    await beat(actor, { visible: true, idleSeconds: 0 });
    await beat(actor, { visible: true, idleSeconds: 3 });
    await beat(actor, { visible: true, idleSeconds: 1 });
    let spans = await spansOf(actor.userId);
    expect(spans).toHaveLength(1);
    expect(spans[0]?.state).toBe('active');
    expect(spans[0]?.ended_at.getTime()).toBeGreaterThan(spans[0]?.started_at.getTime() ?? 0);

    // Ten minutes without input: idle, a new span that starts where the active one ended. A
    // report never moves "last active" back, so the stored instant is moved, as the M41 test does.
    await withSystem(
      (tx) =>
        tx.execute(sql`
          update team.presence set last_active_at = now() - interval '10 minutes'
          where org_id = ${ORG_A} and user_id = ${actor.userId}
        `),
      { orgId: ORG_A },
    );
    await beat(actor, { visible: false, idleSeconds: 0 });
    // "Not taking orders": a paused span.
    const pause = await actor.client.request('POST', '/v1/team/presence/pause', {
      body: { paused: true },
    });
    expect(pause.statusCode).toBe(201);
    spans = await spansOf(actor.userId);
    expect(spans.map((s) => [s.state, s.paused])).toEqual([
      ['active', false],
      ['idle', false],
      ['active', true],
    ]);
    expect(spans[1]?.started_at.getTime()).toBe(spans[0]?.ended_at.getTime());
    expect(spans[2]?.started_at.getTime()).toBe(spans[1]?.ended_at.getTime());

    // Two more reports while paused extend the paused span; then the hours, read the way the
    // staff-activity module reads them, add up to exactly what the rows say.
    await beat(actor, { visible: true, idleSeconds: 0 });
    await beat(actor, { visible: true, idleSeconds: 0 });
    spans = await spansOf(actor.userId);
    expect(spans).toHaveLength(3);
    const from = new Date((spans[0]?.started_at.getTime() ?? 0) - 60_000);
    const to = new Date((spans[2]?.ended_at.getTime() ?? 0) + 60_000);
    const read = await withOrg({ orgId: ORG_A, userId: actor.userId }, (tx) =>
      team.presenceSpans(tx, ORG_A, { from, to, userId: actor.userId }),
    );
    const totals = presenceTotals(read.get(actor.userId) ?? [], from, to);
    const length = (span: Span | undefined) =>
      (span?.ended_at.getTime() ?? 0) - (span?.started_at.getTime() ?? 0);
    expect(totals.activeMs).toBe(length(spans[0]) + length(spans[2]));
    expect(totals.idleMs).toBe(length(spans[1]));
    expect(totals.pausedMs).toBe(length(spans[2]));
    expect(totals.pausedMs).toBeGreaterThan(0);
    expect(totals.activeMs + totals.idleMs + totals.offlineMs).toBe(to.getTime() - from.getTime());
    expect(totals.offlineMs).toBe(120_000);
  }, 60_000);

  it('starts a separate span after a gap longer than the away threshold', async () => {
    const actor = await harness.asRole('warehouse', ORG_A);
    // Yesterday's last span, ended ten minutes ago.
    await withSystem(
      (tx) =>
        tx.execute(sql`
          insert into team.presence_spans (org_id, user_id, state, paused, started_at, ended_at)
          values (${ORG_A}, ${actor.userId}, 'active', false,
                  now() - interval '1 hour', now() - interval '10 minutes')
        `),
      { orgId: ORG_A },
    );
    await beat(actor, { visible: true, idleSeconds: 0 });
    const spans = await spansOf(actor.userId);
    expect(spans).toHaveLength(2);
    const [earlier, now] = spans;
    expect(now?.started_at.getTime()).toBe(now?.ended_at.getTime());
    const gapMs = (now?.started_at.getTime() ?? 0) - (earlier?.ended_at.getTime() ?? 0);
    expect(gapMs).toBeGreaterThan(9 * 60_000);

    // The hours: 50 minutes active in the last hour and a quarter, the rest offline.
    const read = await withOrg({ orgId: ORG_A, userId: actor.userId }, (tx) =>
      team.presenceSpans(tx, ORG_A, {
        from: new Date(Date.now() - 75 * 60_000),
        to: new Date(Date.now() + 60_000),
        userId: actor.userId,
      }),
    );
    const mine = read.get(actor.userId) ?? [];
    expect(mine).toHaveLength(2);
    expect(spansOverlap(mine)).toBe(false);
    const totals = presenceTotals(mine, new Date(Date.now() - 75 * 60_000), new Date());
    expect(Math.round(totals.activeMs / 60_000)).toBe(50);
    expect(totals.idleMs).toBe(0);
  }, 60_000);

  it('a span only grows at its end, and another brand sees none of it', async () => {
    const actor = await harness.asRole('sales', ORG_A);
    await beat(actor, { visible: true, idleSeconds: 0 });
    const [span] = await spansOf(actor.userId);
    expect(span).toBeDefined();
    const shrink = refusal(
      withSystem(
        (tx) =>
          tx.execute(sql`
          update team.presence_spans set ended_at = started_at - interval '1 second'
          where id = ${span?.id ?? ''}
        `),
        { orgId: ORG_A },
      ),
    );
    expect(await shrink).toMatch(/never shrinks|presence_spans_order/);
    const restate = refusal(
      withSystem(
        (tx) =>
          tx.execute(sql`
          update team.presence_spans set state = 'idle' where id = ${span?.id ?? ''}
        `),
        { orgId: ORG_A },
      ),
    );
    expect(await restate).toMatch(/only grows at its end/);

    const seenByB = await withOrg({ orgId: ORG_B, userId: actor.userId }, async (tx) => {
      const rows = await tx.execute<{ n: number }>(sql`
        select count(*)::int as n from team.presence_spans where user_id = ${actor.userId}
      `);
      return rows[0]?.n ?? -1;
    });
    expect(seenByB).toBe(0);
  }, 60_000);

  it('two reports at once leave one span, never two overlapping ones', async () => {
    const actor = await harness.asRole('sales', ORG_A);
    await beat(actor, { visible: true, idleSeconds: 0 });
    await Promise.all(
      Array.from({ length: 6 }, (_, i) => beat(actor, { visible: true, idleSeconds: i })),
    );
    const spans = await spansOf(actor.userId);
    expect(spans).toHaveLength(1);
  }, 60_000);
});

describe('presence history retention (D-1005)', () => {
  it('purges spans that ended over 400 days ago, and keeps the rest', async () => {
    const actor = await harness.asRole('sales', ORG_A);
    await withSystem(
      (tx) =>
        tx.execute(sql`
          insert into team.presence_spans (org_id, user_id, state, paused, started_at, ended_at)
          values (${ORG_A}, ${actor.userId}, 'active', false,
                  now() - interval '402 days', now() - interval '401 days'),
                 (${ORG_A}, ${actor.userId}, 'active', false,
                  now() - interval '399 days', now() - interval '398 days')
        `),
      { orgId: ORG_A },
    );
    const removed = await harness.app.get(PresenceHistoryService).purgeAll();
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(await spansOf(actor.userId)).toHaveLength(1);
  }, 60_000);
});
