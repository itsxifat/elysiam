import { describe, expect, it, vi } from 'vitest';

import type { OutboxDispatcher } from '../../platform/events/dispatcher.js';
import type { JobsRuntime } from '../../platform/jobs/jobs.runtime.js';
import type { TrackingDeliveries } from './delivery.service.js';
import type { TrackingOrderEvents } from './order-events.service.js';
import type { TrackingSetupService } from './setup.service.js';
import { TRACKING_QUEUES } from './tracking.queues.js';
import { registerTrackingJobs } from './tracking.worker.js';

/** The worker hears every order's creation and status change, and runs the delivery job. */
describe('the tracking hub’s worker', () => {
  it('subscribes to order.created and order.status_changed and works the delivery queue', async () => {
    const heard = new Map<string, (event: unknown) => Promise<void>>();
    const dispatcher = {
      on: (name: string, handler: (event: unknown) => Promise<void>) => heard.set(name, handler),
    } as unknown as OutboxDispatcher;
    const queues: string[] = [];
    const jobs = {
      work: (queue: string) => {
        queues.push(queue);
        return Promise.resolve();
      },
    } as unknown as JobsRuntime;
    const events = {
      onOrderCreated: vi.fn(() => Promise.resolve()),
      onStatusChanged: vi.fn(() => Promise.resolve()),
    };
    await registerTrackingJobs({
      jobs,
      dispatcher,
      events: events as unknown as TrackingOrderEvents,
      deliveries: {} as TrackingDeliveries,
      setup: { importAll: () => Promise.resolve(0) } as unknown as TrackingSetupService,
      report: () => undefined,
    } as never);
    expect([...heard.keys()].sort()).toEqual(['order.created', 'order.status_changed']);
    await heard.get('order.status_changed')?.({ payload: {} });
    expect(events.onStatusChanged).toHaveBeenCalledTimes(1);
    expect(queues).toEqual([TRACKING_QUEUES.deliver.name, TRACKING_QUEUES.purge.name]);
  });
});
