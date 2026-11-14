import { z } from 'zod';

import type { OutboxDispatcher } from '../../platform/events/dispatcher.js';
import type { JobFailureReporter, JobsRuntime } from '../../platform/jobs/jobs.runtime.js';
import type { TrackingDeliveries } from './delivery.service.js';
import type { TrackingOrderEvents } from './order-events.service.js';
import type { TrackingSetupService } from './setup.service.js';
import { TRACKING_QUEUES } from './tracking.queues.js';

const deliverPayload = z.object({ deliveryId: z.string().uuid() }).strict();

export interface TrackingWorkerDependencies {
  readonly jobs: JobsRuntime;
  readonly dispatcher: OutboxDispatcher;
  readonly events: TrackingOrderEvents;
  readonly deliveries: TrackingDeliveries;
  readonly setup: TrackingSetupService;
  readonly report: JobFailureReporter;
}

/**
 * The tracking hub's worker (M54): every order's stages from the outbox, one delivery per job,
 * the nightly purge, and the one-time import at boot (D-961).
 */
export async function registerTrackingJobs(deps: TrackingWorkerDependencies): Promise<void> {
  const { jobs, dispatcher, events, deliveries, setup, report } = deps;

  dispatcher.on('order.created', (event) => events.onOrderCreated(event));
  dispatcher.on('order.status_changed', (event) => events.onStatusChanged(event));

  await jobs.work(
    TRACKING_QUEUES.deliver.name,
    async (job) => {
      if (job.orgId === null) throw new Error(`${TRACKING_QUEUES.deliver.name} is tenant-scoped`);
      const { deliveryId } = deliverPayload.parse(job.payload);
      await deliveries.deliver(job.orgId, deliveryId);
    },
    report,
  );
  await jobs.work(
    TRACKING_QUEUES.purge.name,
    async () => {
      await deliveries.purgeAll();
    },
    report,
  );
  // The one-time import (D-961), in the background: every path that needs a brand's settings
  // also imports them first, so this only saves the first event of each brand the wait.
  void setup.importAll().catch(() => undefined);
}
