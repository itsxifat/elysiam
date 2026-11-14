import { randomUUID } from 'node:crypto';

import { SEED_ORG_IDS, withSystem } from '@elysium/db';
import { sql } from 'drizzle-orm';

/**
 * How the route-matrix suite and the cost sweep call M54's routes (D-070). The test environment
 * runs the fake gateway, so nothing reaches Meta or Google. Saving a destination keeps its ids
 * as they are (empty), so marketing's save is the switches' and is admitted; the test send finds
 * nothing set up and is refused with `TRACKING_NOT_READY` (still an admission). Retry is asked
 * about a delivery still queued and is refused with `TRACKING_RETRY_INVALID` (an admission): the
 * matrix runs no jobs runtime, and a retry that succeeds enqueues; `tracking.e2e.test.ts` covers it.
 */

interface Call {
  readonly url: string;
  readonly body?: unknown;
}

const ORG_A = SEED_ORG_IDS['elysium-lifestyle-bd'] ?? '';

/** A delivery still queued, on an event of its own. */
async function queuedDelivery(): Promise<string> {
  return withSystem(
    async (tx) => {
      const event = await tx.execute<{ id: string }>(sql`
        insert into tracking.events
          (org_id, kind, event_id, event_name, event_time, expires_at)
        values (${ORG_A}, 'test', ${`test_${randomUUID()}`}, 'ErpConnectionTest', now(),
                now() + interval '30 days')
        returning id
      `);
      const delivery = await tx.execute<{ id: string }>(sql`
        insert into tracking.deliveries (org_id, event_row_id, destination, status, attempts, last_error)
        values (${ORG_A}, ${event[0]?.id ?? ''}, 'meta', 'queued', 0, null)
        returning id
      `);
      return delivery[0]?.id ?? '';
    },
    { orgId: ORG_A },
  );
}

export const TRACKING_ROUTE_FIXTURES: Readonly<Record<string, () => Promise<Call> | Call>> = {
  'GET /v1/tracking': () => ({ url: '/v1/tracking' }),
  'PUT /v1/tracking/settings': () => ({
    url: '/v1/tracking/settings',
    body: {
      purchaseStage: 'confirmed',
      stageRoutes: {},
      webRoutes: [],
      proxy: {
        metaScriptPath: '/e1/s.js',
        metaCollectPath: '/e1/t',
        ga4ScriptPath: '/e2/s.js',
        ga4CollectPath: '/e2',
      },
      testMode: false,
      sendNameAndCity: false,
      chatToGa4: false,
      defaultCountryCode: '880',
      logRetentionDays: 30,
    },
  }),
  'PUT /v1/tracking/destinations/:kind': () => ({
    url: '/v1/tracking/destinations/ga4',
    body: { kind: 'ga4', enabled: false, clientEnabled: false, measurementId: '' },
  }),
  'POST /v1/tracking/destinations/:kind/test': () => ({
    url: '/v1/tracking/destinations/meta/test',
  }),
  'GET /v1/tracking/events': () => ({ url: '/v1/tracking/events?limit=10' }),
  'GET /v1/tracking/summary': () => ({ url: '/v1/tracking/summary' }),
  'GET /v1/tracking/orders/:orderId': () => ({ url: `/v1/tracking/orders/${randomUUID()}` }),
  'POST /v1/tracking/deliveries/:id/retry': async () => ({
    url: `/v1/tracking/deliveries/${await queuedDelivery()}/retry`,
  }),
};
