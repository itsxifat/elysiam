import { DELIVERY_MAX_ATTEMPTS } from '@elysium/domain/tracking';

import type { QueueDefinition } from '../../platform/jobs/queues.js';

/**
 * The tracking hub's jobs (M54, D-962). Each is idempotent; the payload is ids.
 *
 * - `tracking.deliver`: one event to one platform. `tracking-delivery:<id>` keeps one send in
 *   flight per delivery (an `exclusive` queue, D-207); a delivery no longer queued is left alone.
 * - `tracking.purge`: every night, events past each brand's retention and signals past 60 days.
 */
export const TRACKING_QUEUES = {
  deliver: {
    name: 'tracking.deliver',
    scope: 'org',
    policy: 'exclusive',
    retryLimit: DELIVERY_MAX_ATTEMPTS - 1,
    retryDelaySeconds: 60,
    expireInSeconds: 120,
  },
  purge: {
    name: 'tracking.purge',
    scope: 'global',
    cron: '45 3 * * *',
    retryLimit: 2,
    retryDelaySeconds: 600,
    expireInSeconds: 600,
  },
} as const satisfies Record<string, QueueDefinition>;

export const TRACKING_QUEUE_DEFINITIONS: readonly QueueDefinition[] =
  Object.values(TRACKING_QUEUES);
