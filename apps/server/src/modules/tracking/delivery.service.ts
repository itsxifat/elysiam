import { Inject, Injectable } from '@nestjs/common';
import { withGlobal, withOrg } from '@elysium/db';
import { ga4Payload, metaEvent } from '@elysium/domain/storefront';
import {
  DELIVERY_MAX_ATTEMPTS,
  eventTooOld,
  type TrackingDestination,
} from '@elysium/domain/tracking';
import { sql } from 'drizzle-orm';
import type { Logger } from 'pino';

import { open, SealedBoxUnavailable } from '../../platform/crypto/sealed-box.js';
import { createLogger } from '../../platform/logging/logger.js';
import {
  TRACKING_GATEWAY,
  type PlatformResult,
  type TrackingGateway,
} from './providers/gateway.js';
import type { SealedPayload } from './order-events.service.js';
import * as repo from './tracking.repository.js';
import {
  bindings,
  DEFAULT_META_API_VERSION,
  destinationReady,
  metaTarget,
  publicIdsOf,
} from './tracking-state.js';

/** Thrown so pg-boss tries again later; the row already says why. */
export class TrackingRetryLater extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'TrackingRetryLater';
  }
}

type Built =
  | { readonly kind: 'skip'; readonly reason: string }
  | { readonly kind: 'send'; readonly call: () => Promise<PlatformResult> };

/**
 * One event to one platform (D-962), the job `tracking.deliver`, with no transaction open
 * while the platform is called (invariant 6).
 *
 * A delivery not queued (sent, skipped, waiting, failed) is left alone. A refusal the platform
 * named is `failed` at once; an answer a retry could change (a timeout, a 5xx, a 429) stays
 * `queued` and the job is retried by pg-boss, up to `DELIVERY_MAX_ATTEMPTS`, then `failed`.
 * Retry on the log makes a failed one queued again.
 */
@Injectable()
export class TrackingDeliveries {
  private cachedLogger: Logger | undefined;

  private get logger(): Logger {
    this.cachedLogger ??= createLogger('tracking');
    return this.cachedLogger;
  }

  constructor(@Inject(TRACKING_GATEWAY) private readonly gateway: TrackingGateway) {}

  async deliver(orgId: string, deliveryId: string, now: Date = new Date()): Promise<void> {
    const prepared = await withOrg({ orgId, userId: 'system:tracking' }, async (tx) => {
      const row = await repo.deliveryForSend(tx, orgId, deliveryId);
      if (row?.status !== 'queued') return null;
      // Test mode is the event's, fixed when it was written: a test stays a test on Retry.
      const destination = await repo.destination(tx, orgId, row.destination);
      return { row, destination };
    });
    if (prepared === null) return;
    const { row } = prepared;

    let built: Built;
    try {
      built = this.build(orgId, prepared.row, prepared.destination, now);
    } catch (error) {
      if (!(error instanceof SealedBoxUnavailable)) throw error;
      // A payload or a secret this installation cannot open: recorded, never retried.
      this.logger.warn({ deliveryId }, 'a tracked event could not be opened to send');
      built = { kind: 'skip', reason: 'The credentials could not be opened on this server.' };
    }

    if (built.kind === 'skip') {
      await this.finish(orgId, row, {
        status: 'skipped',
        attempts: row.attempts,
        response: {},
        error: built.reason,
      });
      return;
    }
    const result = await built.call();
    const attempts = row.attempts + 1;
    const response = {
      httpStatus: result.httpStatus,
      latencyMs: result.latencyMs,
      ...result.detail,
    };
    if (result.status === 'success') {
      await this.finish(orgId, row, { status: 'sent', attempts, response, error: null });
      return;
    }
    if (result.retryable && attempts < DELIVERY_MAX_ATTEMPTS) {
      await this.finish(orgId, row, { status: 'queued', attempts, response, error: result.error });
      throw new TrackingRetryLater(result.error);
    }
    await this.finish(orgId, row, { status: 'failed', attempts, response, error: result.error });
  }

  private async finish(
    orgId: string,
    row: repo.SendRow,
    outcome: Parameters<typeof repo.finishDelivery>[3],
  ): Promise<void> {
    await withOrg({ orgId, userId: 'system:tracking' }, async (tx) => {
      await repo.finishDelivery(tx, orgId, row.delivery_id, outcome);
      if (outcome.status === 'sent' || outcome.status === 'skipped') {
        await repo.clearPayloadIfDone(tx, orgId, row.event_row_id);
      }
    });
  }

  private build(
    orgId: string,
    row: repo.SendRow,
    destination: repo.DestinationRow | undefined,
    now: Date,
  ): Built {
    const kind = row.destination as TrackingDestination;
    if (destination === undefined || !destination.enabled || !destinationReady(destination)) {
      return { kind: 'skip', reason: 'The platform is switched off or not set up.' };
    }
    if (row.payload_sealed === null) {
      return { kind: 'skip', reason: 'Nothing is left to send: the event’s details were cleared.' };
    }
    const eventTime = new Date(row.event_time);
    if (eventTooOld(kind, eventTime, now)) {
      return { kind: 'skip', reason: 'Too old for the platform to take.' };
    }
    const payload = JSON.parse(
      open(row.payload_sealed, bindings.payload(orgId, row.event_row_id)),
    ) as SealedPayload;
    const secret = open(destination.secret_sealed ?? Buffer.alloc(0), bindings.secret(orgId, kind));
    const ids = publicIdsOf(destination);
    const customData = (row.custom_data ?? {}) as Record<string, unknown>;
    const seconds = Math.floor(eventTime.getTime() / 1000);
    const testMode = row.test_mode;

    if (kind === 'meta') {
      const event = metaEvent({
        eventName: row.event_name,
        eventId: row.event_id,
        eventTime: seconds,
        eventSourceUrl:
          row.action_source === 'website' ? (payload.eventSourceUrl ?? undefined) : undefined,
        actionSource: row.action_source ?? 'other',
        userData: payload.userData,
        customData,
      });
      return {
        kind: 'send',
        call: () =>
          this.gateway.sendMeta({
            apiVersion:
              destination.api_version === '' ? DEFAULT_META_API_VERSION : destination.api_version,
            target: metaTarget(ids),
            token: secret,
            event,
            testEventCode: testMode && destination.test_code !== '' ? destination.test_code : null,
          }),
      };
    }
    if (kind === 'ga4') {
      if (payload.ga4.clientId === null) {
        return { kind: 'skip', reason: 'GA4 needs the website’s client id for this order.' };
      }
      const body = ga4Payload({
        eventName: row.event_name,
        eventId: row.event_id,
        clientId: payload.ga4.clientId,
        sessionId: payload.ga4.sessionId ?? undefined,
        userId: payload.ga4.userId ?? undefined,
        customData,
        extraParams: payload.ga4.params,
        clientIp: payload.clientIp ?? undefined,
        eventTime: seconds,
      });
      return {
        kind: 'send',
        call: () =>
          this.gateway.sendGa4({
            measurementId: ids.measurementId ?? '',
            apiSecret: secret,
            payload: body,
            userAgent: payload.userAgent,
            debug: testMode,
          }),
      };
    }
    return { kind: 'skip', reason: 'That platform is not set up yet.' };
  }

  /** The nightly purge: every brand's events past their retention, signals past 60 days. */
  async purgeAll(): Promise<number> {
    const orgIds = await withGlobal(async (tx) => {
      const rows = await tx.execute<{ id: string }>(
        sql`select id from org.organizations order by slug`,
      );
      return [...rows].map((row) => row.id);
    });
    let removed = 0;
    for (const orgId of orgIds) {
      removed += await withOrg({ orgId, userId: 'system:tracking' }, (tx) => repo.purge(tx, orgId));
    }
    return removed;
  }
}
