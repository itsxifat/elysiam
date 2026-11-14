import { createHash, randomInt, randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { withOrg, type Tx } from '@elysium/db';
import { decimalToPoisha, poisha, type Poisha } from '@elysium/domain';
import {
  boundedCustomData,
  metaUserData,
  type MetaUserData,
  type TrackingUser,
} from '@elysium/domain/storefront';
import {
  cleanSignals,
  eventTooOld,
  isPurchaseStage,
  orderActionSource,
  orderCustomData,
  orderEventDestinations,
  orderLogView,
  orderTrackingUser,
  ORDER_SIGNALS_DAYS,
  refundCustomData,
  refundDue,
  refundEventId,
  signalsPresent,
  stageEventId,
  stageEventName,
  stageForStatus,
  stageValue,
  syntheticGa4ClientId,
  type OrderSignals,
  type OrderStage,
  type TrackingDestination,
} from '@elysium/domain/tracking';
import type { Logger } from 'pino';

import {
  open,
  seal,
  sealedBoxConfigured,
  SealedBoxUnavailable,
} from '../../platform/crypto/sealed-box.js';
import type { DeliveredEvent } from '../../platform/events/dispatcher.js';
import { enqueue } from '../../platform/jobs/enqueue.js';
import { createLogger } from '../../platform/logging/logger.js';
import { ORDERS_API, type OrdersApi } from '../orders/orders.api.js';
import { TrackingSetupService } from './setup.service.js';
import type { BrowserEventsInput, BrowserEventsResult } from './tracking.api.js';
import { TRACKING_QUEUES } from './tracking.queues.js';
import * as repo from './tracking.repository.js';
import { bindings, destinationStates, hubSettings, type HubSettings } from './tracking-state.js';

const ACTOR = 'system:tracking';

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

/**
 * What is sealed until an event is sent (D-959): everything personal, hashed where it can be,
 * and the ids the platforms take in the clear. Cleared once every delivery is final.
 */
export interface SealedPayload {
  readonly userData: MetaUserData;
  readonly eventSourceUrl: string | null;
  readonly ga4: {
    readonly clientId: string | null;
    readonly sessionId: string | null;
    readonly userId: string | null;
    readonly params: Readonly<Record<string, unknown>>;
  };
  readonly clientIp: string | null;
  readonly userAgent: string | null;
}

interface EventEntry {
  readonly kind: 'stage' | 'refund' | 'browser';
  readonly eventId: string;
  readonly eventName: string;
  readonly stage: OrderStage | null;
  readonly orderId: string | null;
  readonly valuePoisha: Poisha | null;
  readonly customData: Readonly<Record<string, unknown>>;
  readonly user: TrackingUser;
  readonly actionSource: string;
  readonly eventSourceUrl: string | null;
  readonly ga4: SealedPayload['ga4'];
  readonly eventTime: Date;
  readonly destinations: readonly TrackingDestination[];
  readonly waiting: boolean;
}

/**
 * Every order's stage events, whatever its channel (M54, D-957, D-959, D-967), the website's
 * signals for them (D-963), and the browser events the website forwards.
 *
 * The outbox tells the worker an order was created or changed status; each stage is written
 * once (its event id is unique per brand), with one delivery per platform queued in the same
 * transaction. The sends are the delivery job's, with no transaction open (invariant 6).
 */
@Injectable()
export class TrackingOrderEvents {
  private cachedLogger: Logger | undefined;

  private get logger(): Logger {
    this.cachedLogger ??= createLogger('tracking');
    return this.cachedLogger;
  }

  constructor(
    @Inject(ORDERS_API) private readonly orders: OrdersApi,
    private readonly setup: TrackingSetupService,
  ) {}

  // --- the outbox -----------------------------------------------------------------------------

  async onOrderCreated(event: DeliveredEvent): Promise<void> {
    const payload = event.payload as { id?: unknown; createdAt?: unknown };
    if (typeof payload.id !== 'string') return;
    const at =
      typeof payload.createdAt === 'string' ? new Date(payload.createdAt) : event.occurredAt;
    await this.stage(
      event.orgId,
      payload.id,
      'placed',
      Number.isNaN(at.getTime()) ? event.occurredAt : at,
    );
  }

  async onStatusChanged(event: DeliveredEvent): Promise<void> {
    const payload = event.payload as { id?: unknown; to?: unknown; at?: unknown };
    if (typeof payload.id !== 'string' || typeof payload.to !== 'string') return;
    const stage = stageForStatus(payload.to);
    if (stage === null) return;
    const at = typeof payload.at === 'string' ? new Date(payload.at) : event.occurredAt;
    await this.stage(
      event.orgId,
      payload.id,
      stage,
      Number.isNaN(at.getTime()) ? event.occurredAt : at,
    );
  }

  /**
   * One order stage: its event to every platform it is routed to, and, after a sent purchase,
   * GA4's refund for what the buyer did not keep (D-967). Nothing for a brand that sends
   * nowhere, and nothing personal kept on a server with no sealed box.
   */
  async stage(orgId: string, orderId: string, stage: OrderStage, at: Date): Promise<void> {
    // The outbox row is shared with mail, the marketplace, the inbox and the offers: a tracking
    // failure is logged and lost here, never retried into theirs (the M54 ledger audit's W1).
    try {
      await this.writeStage(orgId, orderId, stage, at);
    } catch (error) {
      this.logger.error({ err: error, orgId, orderId, stage }, 'an order stage was not tracked');
    }
  }

  private async writeStage(
    orgId: string,
    orderId: string,
    stage: OrderStage,
    at: Date,
  ): Promise<void> {
    await this.setup.importIfNeeded(orgId);
    if (!sealedBoxConfigured()) return;
    await withOrg({ orgId, userId: ACTOR }, async (tx) => {
      const settings = hubSettings(await repo.settings(tx, orgId));
      const states = destinationStates(await repo.destinations(tx, orgId));
      if (stage === 'cancelled') await repo.skipWaiting(tx, orgId, orderId);
      if (!states.some((state) => state.enabled && state.ready)) return;
      const facts = await this.orders.trackingFacts(tx, orgId, orderId);
      if (facts === null) return;
      const signalsRow = await repo.signals(tx, orgId, orderId);
      let signals: OrderSignals = {};
      if (signalsRow !== undefined) {
        try {
          signals = cleanSignals(
            JSON.parse(open(signalsRow.signals_sealed, bindings.signals(orgId, orderId))),
          );
        } catch (error) {
          // Sealed under a key this server no longer has: the order goes without them.
          if (!(error instanceof SealedBoxUnavailable)) throw error;
        }
      }
      const awaitingPayment =
        signalsRow !== undefined &&
        (signalsRow.present as Record<string, unknown> | null)?.awaitingPayment === true;
      const domainFacts = {
        orderId: facts.orderId,
        orderNo: facts.orderNo,
        channel: facts.channel,
        customerId: facts.customerId,
        phoneE164: facts.phoneE164,
        email: facts.email,
        name: facts.name,
        city: facts.city,
        lines: facts.lines,
      };
      const user = orderTrackingUser(domainFacts, signals, {
        sendNameAndCity: settings.sendNameAndCity,
        placedAt: facts.placedAt,
      });
      const order = { channel: facts.channel, hasGaClientId: signals.gaClientId !== undefined };
      const ga4 = {
        clientId:
          signals.gaClientId ??
          (settings.chatToGa4 ? syntheticGa4ClientId(facts.customerId, sha256) : null),
        sessionId: signals.gaSessionId ?? null,
        userId: facts.customerId,
        params: {},
      };
      const common = {
        orderId,
        user,
        actionSource: orderActionSource(facts.channel, signals.eventSourceUrl),
        eventSourceUrl: signals.eventSourceUrl ?? null,
        ga4,
        eventTime: at,
      };

      const destinations = orderEventDestinations({
        kind: 'stage',
        stage,
        routes: settings.stageRoutes,
        destinations: states,
        order,
        chatToGa4: settings.chatToGa4,
      });
      if (destinations.length > 0) {
        const value = stageValue(stage, {
          netItemsPoisha: facts.netItemsPoisha,
          deliveredPoisha: facts.deliveredPoisha,
        });
        await this.write(tx, orgId, settings, {
          ...common,
          kind: 'stage',
          eventId: stageEventId(stage, facts.orderNo, settings.purchaseStage),
          eventName: stageEventName(stage, settings.purchaseStage),
          stage,
          valuePoisha: value,
          customData: orderCustomData(domainFacts, value),
          destinations,
          waiting: isPurchaseStage(stage, settings.purchaseStage) && awaitingPayment,
        });
      }

      if (
        stage === 'placed' ||
        stage === 'confirmed' ||
        isPurchaseStage(stage, settings.purchaseStage)
      ) {
        return;
      }
      const purchase = await repo.ga4PurchaseOf(tx, orgId, `purchase_${facts.orderNo}`);
      if (purchase === undefined) return;
      const due = refundDue({
        stage,
        purchasePoisha: poisha(purchase.valuePoisha),
        deliveredPoisha: facts.deliveredPoisha,
        refundedPoisha: poisha(await repo.refundedFor(tx, orgId, orderId)),
      });
      if (due <= 0n) return;
      const refundTo = orderEventDestinations({
        kind: 'refund',
        stage,
        routes: settings.stageRoutes,
        destinations: states,
        order,
        chatToGa4: settings.chatToGa4,
      });
      if (refundTo.length === 0) return;
      await this.write(tx, orgId, settings, {
        ...common,
        kind: 'refund',
        eventId: refundEventId(stage, facts.orderNo),
        eventName: 'refund',
        stage,
        valuePoisha: due,
        customData: refundCustomData(facts.orderNo, due),
        destinations: refundTo,
        waiting: false,
      });
    });
  }

  // --- the website's hand-offs (TRACKING_API) -------------------------------------------------

  /** In the checkout's transaction (D-963): sealed, kept 60 days. Never fails the sale. */
  async recordOrderSignals(
    tx: Tx,
    orgId: string,
    orderId: string,
    raw: OrderSignals,
    options: { readonly awaitingPayment: boolean },
  ): Promise<void> {
    if (!sealedBoxConfigured()) return;
    const signals = cleanSignals(raw);
    try {
      await tx.transaction(async (savepoint) => {
        const sealed = seal(JSON.stringify(signals), bindings.signals(orgId, orderId));
        await repo.upsertSignals(savepoint, orgId, orderId, {
          sealed: sealed.ciphertext,
          keyId: sealed.keyId,
          present: { ...signalsPresent(signals), awaitingPayment: options.awaitingPayment },
          days: ORDER_SIGNALS_DAYS,
        });
      });
    } catch (error) {
      // A savepoint: signals that cannot be kept are lost, never the order (M35b's rule).
      this.logger.error({ err: error, orderId }, 'the order’s tracking signals were not kept');
    }
  }

  /** In the payment's transaction: the order's waiting Purchase goes now. */
  async paymentBooked(tx: Tx, orgId: string, orderId: string): Promise<void> {
    await repo.setAwaitingPayment(tx, orgId, orderId, false);
    for (const deliveryId of await repo.releaseWaiting(tx, orgId, orderId)) {
      await enqueue(
        tx,
        TRACKING_QUEUES.deliver.name,
        { deliveryId },
        { orgId, ref: deliveryId, singletonKey: `tracking-delivery:${deliveryId}` },
      );
    }
  }

  /**
   * Browser events the website forwards (M35b's `/storefront/v1/events`, now the hub's): each
   * logged and queued for the platforms its route names, or answered `skipped`. A browser
   * `Purchase` is always skipped: the hub sends every order's Purchase itself, at the brand's
   * stage, under the id the browser fired it with (D-957, D-965).
   */
  async ingestBrowserEvents(
    orgId: string,
    input: BrowserEventsInput,
  ): Promise<BrowserEventsResult> {
    await this.setup.importIfNeeded(orgId);
    const now = new Date();
    return withOrg({ orgId, userId: ACTOR }, async (tx) => {
      const settings = hubSettings(await repo.settings(tx, orgId));
      const states = destinationStates(await repo.destinations(tx, orgId));
      const results: { eventId: string; status: 'queued' | 'skipped' }[] = [];
      for (const event of input.events) {
        const eventId = event.eventId ?? `${event.eventName.toLowerCase()}_${randomId()}`;
        const seconds = Math.min(
          event.eventTime ?? Math.floor(now.getTime() / 1000),
          Math.floor(now.getTime() / 1000),
        );
        const eventTime = new Date(seconds * 1000);
        const route = settings.webRoutes.find((known) => known.name === event.eventName);
        const routed = (kind: TrackingDestination): boolean =>
          route === undefined ||
          (route.enabled &&
            route.server &&
            (kind === 'meta'
              ? route.meta
              : kind === 'ga4'
                ? route.ga4
                : kind === 'tiktok'
                  ? route.tiktok
                  : false));
        const destinations = states
          .filter((state) => state.enabled && state.ready && routed(state.kind))
          .map((state) => state.kind)
          .filter((kind) => !eventTooOld(kind, eventTime, now));
        if (event.eventName === 'Purchase' || destinations.length === 0 || !sealedBoxConfigured()) {
          results.push({ eventId, status: 'skipped' });
          continue;
        }
        const customData = boundedCustomData(event.customData);
        const userData = event.userData ?? {};
        await this.write(tx, orgId, settings, {
          kind: 'browser',
          eventId,
          eventName: event.eventName,
          stage: null,
          orderId: null,
          valuePoisha: valueOf(customData.value),
          customData,
          user: {
            email: userData.email,
            phone: userData.phone,
            firstName: userData.firstName,
            lastName: userData.lastName,
            city: userData.city,
            state: userData.state,
            zip: userData.zip,
            country: userData.country,
            externalId: userData.externalId,
            fbp: userData.fbp,
            fbc: userData.fbc,
            clientIpAddress: input.client?.ip,
            clientUserAgent: input.client?.userAgent,
          },
          actionSource: event.actionSource ?? 'website',
          eventSourceUrl: event.eventSourceUrl ?? null,
          ga4: {
            clientId: event.ga4?.clientId ?? fallbackClientId(),
            sessionId: event.ga4?.sessionId ?? null,
            userId: event.ga4?.userId ?? null,
            params: event.ga4?.params ?? {},
          },
          eventTime,
          destinations,
          waiting: false,
        });
        results.push({ eventId, status: 'queued' });
      }
      return { ok: true as const, results };
    });
  }

  // --- writing ----------------------------------------------------------------------------------

  /** One event, once, sealed, with a delivery per platform queued in the same transaction. */
  private async write(
    tx: Tx,
    orgId: string,
    settings: HubSettings,
    entry: EventEntry,
  ): Promise<void> {
    const id = randomUUID();
    const payload: SealedPayload = {
      userData: metaUserData(entry.user, sha256, settings.defaultCountryCode),
      eventSourceUrl: entry.eventSourceUrl,
      ga4: entry.ga4,
      clientIp: entry.user.clientIpAddress ?? null,
      userAgent: entry.user.clientUserAgent ?? null,
    };
    const sealed = seal(JSON.stringify(payload), bindings.payload(orgId, id));
    const view = orderLogView(entry.user);
    const inserted = await repo.insertEvent(tx, orgId, {
      id,
      kind: entry.kind,
      eventId: entry.eventId,
      eventName: entry.eventName,
      stage: entry.stage,
      orderId: entry.orderId,
      valuePoisha: entry.valuePoisha,
      currency: typeof entry.customData.currency === 'string' ? entry.customData.currency : null,
      actionSource: entry.actionSource,
      userMasked: view.userMasked,
      matchKeys: view.matchKeys,
      customData: entry.customData,
      payload: { sealed: sealed.ciphertext, keyId: sealed.keyId },
      eventTime: entry.eventTime,
      testMode: settings.testMode,
      retentionDays: settings.logRetentionDays,
    });
    if (!inserted) return;
    for (const destination of entry.destinations) {
      const deliveryId = await repo.insertDelivery(
        tx,
        orgId,
        id,
        destination,
        entry.waiting ? 'waiting' : 'queued',
        entry.waiting ? 'Waiting for the online payment.' : null,
      );
      if (deliveryId === undefined || entry.waiting) continue;
      await enqueue(
        tx,
        TRACKING_QUEUES.deliver.name,
        { deliveryId },
        { orgId, ref: deliveryId, singletonKey: `tracking-delivery:${deliveryId}` },
      );
    }
  }
}

/** The browser's `value` as poisha, when it is a plain amount; nothing otherwise. */
function valueOf(value: unknown): Poisha | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  try {
    return decimalToPoisha(String(value));
  } catch {
    return null;
  }
}

function randomId(): string {
  return `${Date.now().toString(36)}${randomInt(0, 2 ** 31 - 1).toString(36)}`;
}

/** GA4 needs a client id; a browser that sent none gets the old site's made-up one. */
function fallbackClientId(): string {
  return `${String(Math.floor(Date.now() / 1000))}.${String(randomInt(0, 1_000_000_000))}`;
}
