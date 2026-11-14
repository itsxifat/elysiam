import type { QueueDefinition } from '../../platform/jobs/queues.js';

/** The team module's jobs (M57): the nightly purge of presence history past 400 days (D-1005). */
export const TEAM_QUEUES = {
  purgeSpans: {
    name: 'team.purge_spans',
    scope: 'global',
    cron: '15 4 * * *',
    retryLimit: 2,
    retryDelaySeconds: 600,
    expireInSeconds: 600,
  },
} as const satisfies Record<string, QueueDefinition>;

export const TEAM_QUEUE_DEFINITIONS: readonly QueueDefinition[] = Object.values(TEAM_QUEUES);
