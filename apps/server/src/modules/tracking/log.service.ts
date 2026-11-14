import { Injectable } from '@nestjs/common';
import type {
  TrackingDeliveryStatus,
  TrackingDeliveryView,
  TrackingDestinationKind,
  TrackingDestinationWeek,
  TrackingEventView,
  TrackingLogPage,
  TrackingLogQuery,
  TrackingOrderStage,
  TrackingSummary,
} from '@elysium/contracts/tracking';
import { TRACKING_DESTINATION_KINDS } from '@elysium/contracts/tracking';
import { withOrg } from '@elysium/db';
import { eventStatus } from '@elysium/domain/tracking';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { enqueue } from '../../platform/jobs/enqueue.js';
import { TrackingError } from './tracking.errors.js';
import { TRACKING_QUEUES } from './tracking.queues.js';
import * as repo from './tracking.repository.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The event log (M54): every event the hub wrote, newest first, with each platform's delivery;
 * a week's summary per platform; one order's events; and Retry. Masked buyers only, never a
 * hash, a payload or a secret.
 */
@Injectable()
export class TrackingLog {
  constructor(private readonly audit: AuditService) {}

  async page(context: ActiveContext, query: TrackingLogQuery): Promise<TrackingLogPage> {
    const before = decodeCursor(query.cursor);
    return withOrg(context, async (tx) => {
      const rows = await repo.logPage(tx, context.orgId, {
        stage: query.stage,
        kind: query.kind,
        destination: query.destination,
        status: query.status,
        orderId: query.orderId,
        before,
        limit: query.limit + 1,
      });
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      return {
        items: page.map(eventView),
        nextCursor:
          rows.length > query.limit && last !== undefined
            ? Buffer.from(
                JSON.stringify([new Date(last.created_at).toISOString(), last.id]),
              ).toString('base64url')
            : null,
      };
    });
  }

  async order(context: ActiveContext, orderId: string): Promise<TrackingLogPage> {
    return withOrg(context, async (tx) => {
      const rows = await repo.logPage(tx, context.orgId, {
        orderId,
        before: null,
        limit: 50,
      });
      return { items: rows.map(eventView), nextCursor: null };
    });
  }

  async summary(context: ActiveContext, now: Date = new Date()): Promise<TrackingSummary> {
    const since = new Date(now.getTime() - 7 * DAY_MS);
    return withOrg(context, async (tx) => {
      const rows = await repo.summary(tx, context.orgId, since);
      const destinations: TrackingDestinationWeek[] = TRACKING_DESTINATION_KINDS.map((kind) => {
        const mine = rows.filter((row) => row.destination === kind);
        const count = (status: string) =>
          mine.filter((row) => row.status === status).reduce((total, row) => total + row.count, 0);
        const keys = (mine.find((row) => row.status === 'sent')?.match_keys ?? {}) as Record<
          string,
          number
        >;
        return {
          destination: kind,
          sent: count('sent'),
          failed: count('failed'),
          skipped: count('skipped'),
          waiting: count('waiting') + count('queued'),
          matchKeys: keys,
        };
      });
      return { since: since.toISOString(), destinations };
    });
  }

  /** A failed delivery goes back to the queue (D-962); anything else is refused. */
  async retry(
    context: ActiveContext,
    request: AuditableRequest | undefined,
    deliveryId: string,
  ): Promise<{ readonly ok: true }> {
    return withOrg(context, async (tx) => {
      const outcome = await repo.requeueFailed(tx, context.orgId, deliveryId);
      if (!outcome.exists) {
        throw new TrackingError('TRACKING_NOT_FOUND', 'No such delivery in this brand.');
      }
      if (!outcome.ok) {
        throw new TrackingError(
          'TRACKING_RETRY_INVALID',
          'Only a failed delivery can be tried again.',
        );
      }
      await enqueue(
        tx,
        TRACKING_QUEUES.deliver.name,
        { deliveryId },
        { orgId: context.orgId, ref: deliveryId, singletonKey: `tracking-delivery:${deliveryId}` },
      );
      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'update',
        action: 'tracking.delivery_retried',
        entityType: 'tracking.deliveries',
        entityId: deliveryId,
        before: { status: 'failed' },
        after: { status: 'queued' },
        requestId: context.requestId,
        ...(request === undefined ? {} : { request }),
      });
      return { ok: true as const };
    });
  }
}

function eventView(row: repo.LogRow): TrackingEventView {
  const deliveries = (Array.isArray(row.deliveries) ? row.deliveries : []) as Record<
    string,
    unknown
  >[];
  const views: TrackingDeliveryView[] = deliveries.map((delivery) => ({
    id: String(delivery.id),
    destination: String(delivery.destination) as TrackingDestinationKind,
    status: String(delivery.status) as TrackingDeliveryStatus,
    attempts: Number(delivery.attempts ?? 0),
    error: typeof delivery.error === 'string' ? delivery.error : null,
    detail:
      delivery.detail !== null && typeof delivery.detail === 'object'
        ? (delivery.detail as Record<string, unknown>)
        : {},
    sentAt: typeof delivery.sentAt === 'string' ? new Date(delivery.sentAt).toISOString() : null,
  }));
  const customData = (row.custom_data ?? {}) as Record<string, unknown>;
  const user = (row.user_masked ?? {}) as Record<string, unknown>;
  return {
    id: row.id,
    kind: row.kind as TrackingEventView['kind'],
    eventId: row.event_id,
    eventName: row.event_name,
    stage: row.stage as TrackingOrderStage | null,
    orderId: row.order_id,
    orderNo:
      row.order_id !== null && typeof customData.order_id === 'string' ? customData.order_id : null,
    value: row.value_poisha,
    currency: row.currency,
    actionSource: row.action_source,
    user: {
      email: typeof user.email === 'string' ? user.email : '',
      phone: typeof user.phone === 'string' ? user.phone : '',
    },
    matchKeys: (row.match_keys ?? {}) as Record<string, boolean>,
    testMode: row.test_mode,
    eventTime: new Date(row.event_time).toISOString(),
    createdAt: new Date(row.created_at).toISOString(),
    status: eventStatus(views.map((view) => view.status)),
    deliveries: views,
  };
}

function decodeCursor(cursor: string | undefined): { createdAt: string; id: string } | null {
  if (cursor === undefined || cursor === '') return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (
      Array.isArray(parsed) &&
      typeof parsed[0] === 'string' &&
      typeof parsed[1] === 'string' &&
      /^[0-9a-f-]{36}$/i.test(parsed[1]) &&
      !Number.isNaN(Date.parse(parsed[0]))
    ) {
      return { createdAt: parsed[0], id: parsed[1] };
    }
  } catch {
    return null;
  }
  return null;
}
