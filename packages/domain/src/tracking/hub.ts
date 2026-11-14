import { CAPI_MAX_AGE_MS, capiActionSource } from '../marketing/meta.js';
import { poisha, poishaToMajorNumber, sub, type Poisha } from '../money/index.js';
import {
  ga4Payload,
  metaEvent,
  metaUserData,
  trackingMaskedUser,
  trackingMatchKeys,
  type TrackingHash,
  type TrackingUser,
} from '../storefront/tracking.js';

/**
 * The tracking hub (M54, D-957 to D-969): which events an order's life makes, what they are
 * called and worth, which platforms each goes to, and what each platform is sent.
 *
 * Every order, whatever its channel, makes one event per stage it reaches. The brand's
 * Purchase stage (confirmed by default, the owner's choice, D-957) is sent as `Purchase`; the
 * others as custom events. Event ids are deterministic, so an outbox event heard twice is one
 * event, and the Purchase keeps the website's old id (`purchase_<order no>`), so a browser
 * Purchase fired under it is the same purchase to Meta.
 *
 * Personal data is normalised and hashed by the same functions the website's tracking uses
 * (`storefront/tracking.ts`, built on M18's `marketing/meta.ts`). Nothing here sends anything.
 */

export const TRACKING_DESTINATIONS = ['meta', 'ga4', 'tiktok', 'google_ads'] as const;
export type TrackingDestination = (typeof TRACKING_DESTINATIONS)[number];

export const ORDER_STAGES = ['placed', 'confirmed', 'delivered', 'returned', 'cancelled'] as const;
export type OrderStage = (typeof ORDER_STAGES)[number];

export const PURCHASE_STAGES = ['placed', 'confirmed', 'delivered'] as const;
export type PurchaseStage = (typeof PURCHASE_STAGES)[number];

/** The owner's choice (D-957). */
export const DEFAULT_PURCHASE_STAGE: PurchaseStage = 'confirmed';

const ZERO: Poisha = poisha(0n);

/** The custom event each stage is sent as when it is not the Purchase stage. */
export const STAGE_EVENT_NAMES: Readonly<Record<OrderStage, string>> = {
  placed: 'OrderPlaced',
  confirmed: 'OrderConfirmed',
  delivered: 'OrderDelivered',
  returned: 'OrderReturned',
  cancelled: 'OrderCancelled',
};

/**
 * The stage an order status change makes, or none (D-957). A partial delivery is a delivery;
 * a confirmation after a hold is the same confirmation (its id repeats, so nothing new is
 * written); packing, shipping, a return in transit and an exchange make no event.
 */
export function stageForStatus(to: string): OrderStage | null {
  switch (to) {
    case 'confirmed':
      return 'confirmed';
    case 'delivered':
    case 'partially_delivered':
      return 'delivered';
    case 'returned':
      return 'returned';
    case 'cancelled':
      return 'cancelled';
    default:
      return null;
  }
}

/** Whether a stage is the brand's Purchase. */
export function isPurchaseStage(stage: OrderStage, purchaseStage: PurchaseStage): boolean {
  return stage === purchaseStage;
}

export function stageEventName(stage: OrderStage, purchaseStage: PurchaseStage): string {
  return isPurchaseStage(stage, purchaseStage) ? 'Purchase' : STAGE_EVENT_NAMES[stage];
}

/**
 * An order stage's event id. The Purchase keeps the website's id so the browser's and the
 * server's are one purchase; the others are `<stage>_<order no>` (the website fires
 * `OrderPlaced` under `placed_<order no>`, D-965).
 */
export function stageEventId(
  stage: OrderStage,
  orderNo: string,
  purchaseStage: PurchaseStage,
): string {
  return isPurchaseStage(stage, purchaseStage) ? `purchase_${orderNo}` : `${stage}_${orderNo}`;
}

/** A refund's event id: one per stage that refunds, never repeated. */
export function refundEventId(stage: OrderStage, orderNo: string): string {
  return `refund_${stage}_${orderNo}`;
}

/**
 * What the platforms are told an order is worth at a stage (D-960): the net item value after
 * discounts, excluding delivery; at a delivery, what was delivered; at a return or a cancel,
 * what did not stay with the buyer.
 */
export function stageValue(
  stage: OrderStage,
  facts: { readonly netItemsPoisha: Poisha; readonly deliveredPoisha: Poisha | null },
): Poisha {
  const kept = facts.deliveredPoisha ?? ZERO;
  switch (stage) {
    case 'placed':
    case 'confirmed':
      return facts.netItemsPoisha;
    case 'delivered':
      return kept;
    case 'returned':
    case 'cancelled':
      return facts.netItemsPoisha > kept ? sub(facts.netItemsPoisha, kept) : ZERO;
  }
}

/**
 * How much of a sent purchase a stage refunds (D-967): what the purchase was worth, less what
 * the buyer kept, less what was already refunded; never below zero. A delivery refunds only
 * when less was delivered than was bought; a return or cancel refunds the rest.
 */
export function refundDue(input: {
  readonly stage: OrderStage;
  readonly purchasePoisha: Poisha;
  readonly deliveredPoisha: Poisha | null;
  readonly refundedPoisha: Poisha;
}): Poisha {
  if (input.stage === 'placed' || input.stage === 'confirmed') return ZERO;
  if (input.stage === 'delivered' && input.deliveredPoisha === null) return ZERO;
  const kept = input.stage === 'cancelled' ? ZERO : (input.deliveredPoisha ?? ZERO);
  const due = sub(sub(input.purchasePoisha, kept), input.refundedPoisha);
  return due > 0n ? due : ZERO;
}

/** `{ <stage>: { <destination>: boolean } }`, a missing entry on (D-957). */
export type StageRoutes = Readonly<
  Partial<Record<OrderStage, Readonly<Partial<Record<TrackingDestination, boolean>>>>>
>;

export function stageRouted(
  routes: StageRoutes,
  stage: OrderStage,
  destination: TrackingDestination,
): boolean {
  return routes[stage]?.[destination] !== false;
}

/** A stage-routes value as stored, cut to known stages, destinations and booleans. */
export function cleanStageRoutes(input: unknown): StageRoutes {
  const source =
    input !== null && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const out: Partial<Record<OrderStage, Partial<Record<TrackingDestination, boolean>>>> = {};
  for (const stage of ORDER_STAGES) {
    const row = source[stage];
    if (row === null || typeof row !== 'object') continue;
    const cleaned: Partial<Record<TrackingDestination, boolean>> = {};
    for (const destination of TRACKING_DESTINATIONS) {
      const value = (row as Record<string, unknown>)[destination];
      if (typeof value === 'boolean') cleaned[destination] = value;
    }
    out[stage] = cleaned;
  }
  return out;
}

/** What a destination needs before anything can be sent to it. */
export interface DestinationState {
  readonly kind: TrackingDestination;
  readonly enabled: boolean;
  /** Its ids and secret are all there. */
  readonly ready: boolean;
}

/** The order's channel and what is known of the shopper's browser, for routing. */
export interface OrderRouting {
  readonly channel: string;
  /** GA4's `_ga` client id from the website's checkout. */
  readonly hasGaClientId: boolean;
}

/**
 * Which platforms an order event goes to (D-957, D-966, D-967). A refund goes to GA4 alone
 * (Meta and TikTok document none; Google Ads restates in M54b). GA4 hears a chat, phone or
 * desk order only when the brand turned "chat orders to GA4" on, since without the website's
 * tag GA4 reports it partly.
 */
export function orderEventDestinations(input: {
  readonly kind: 'stage' | 'refund';
  readonly stage: OrderStage;
  readonly routes: StageRoutes;
  readonly destinations: readonly DestinationState[];
  readonly order: OrderRouting;
  readonly chatToGa4: boolean;
}): TrackingDestination[] {
  return input.destinations
    .filter((destination) => destination.enabled && destination.ready)
    .map((destination) => destination.kind)
    .filter((kind) => {
      if (input.kind === 'refund') return kind === 'ga4';
      if (!stageRouted(input.routes, input.stage, kind)) return false;
      if (kind === 'ga4') return input.order.hasGaClientId || input.chatToGa4;
      // TikTok and Google Ads arrive in M54b; until then they are never ready.
      return true;
    })
    .sort((a, b) => TRACKING_DESTINATIONS.indexOf(a) - TRACKING_DESTINATIONS.indexOf(b));
}

/**
 * Meta's `action_source` for an order (D-256): the website's own orders are `website` when
 * the checkout's page address is known (Meta requires `event_source_url` for it); chats,
 * calls and walk-ins as M18 decided; the rest `other`.
 */
export function orderActionSource(channel: string, eventSourceUrl: string | undefined): string {
  if (channel === 'website' && (eventSourceUrl ?? '') !== '') return 'website';
  return capiActionSource(channel);
}

/**
 * How old an event may be when it is sent, per platform. Meta refuses a whole request holding
 * one event older than seven days (an hour kept in hand, M18's rule); GA4 moves an event older
 * than 72 hours to 72 hours ago, which would misdate it, so it is skipped instead.
 */
export const MAX_EVENT_AGE_MS: Readonly<Record<TrackingDestination, number>> = {
  meta: CAPI_MAX_AGE_MS,
  ga4: 72 * 60 * 60 * 1000 - 60 * 60 * 1000,
  // M54b: TikTok documents no limit, Google's is the conversion action's click window.
  tiktok: CAPI_MAX_AGE_MS,
  google_ads: 90 * 24 * 60 * 60 * 1000,
};

export function eventTooOld(destination: TrackingDestination, eventTime: Date, now: Date): boolean {
  return now.getTime() - eventTime.getTime() > MAX_EVENT_AGE_MS[destination];
}

/** The order as the hub describes it to the platforms. Raw: hashed when built. */
export interface OrderEventFacts {
  readonly orderId: string;
  readonly orderNo: string;
  readonly channel: string;
  readonly customerId: string;
  readonly phoneE164: string;
  readonly email: string | null;
  readonly name: string | null;
  readonly city: string | null;
  readonly lines: readonly {
    readonly skuCode: string;
    readonly productName: string;
    readonly qty: number;
    readonly unitPricePoisha: Poisha;
  }[];
}

/** What the website knew of the shopper at checkout (D-963). Raw; sealed while stored. */
export interface OrderSignals {
  readonly fbp?: string | undefined;
  readonly fbc?: string | undefined;
  readonly fbclid?: string | undefined;
  readonly ttp?: string | undefined;
  readonly ttclid?: string | undefined;
  readonly gclid?: string | undefined;
  readonly gbraid?: string | undefined;
  readonly wbraid?: string | undefined;
  readonly gaClientId?: string | undefined;
  readonly gaSessionId?: string | undefined;
  readonly ip?: string | undefined;
  readonly userAgent?: string | undefined;
  readonly eventSourceUrl?: string | undefined;
  /** The email typed at checkout, when the buyer's record has none. */
  readonly email?: string | undefined;
}

const SIGNAL_KEYS = [
  'fbp',
  'fbc',
  'fbclid',
  'ttp',
  'ttclid',
  'gclid',
  'gbraid',
  'wbraid',
  'gaClientId',
  'gaSessionId',
  'ip',
  'userAgent',
  'eventSourceUrl',
  'email',
] as const satisfies readonly (keyof OrderSignals)[];

/** The signals kept: known keys, short printable strings, an https page address only. */
export function cleanSignals(input: unknown): OrderSignals {
  const source =
    input !== null && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const out: Record<string, string> = {};
  for (const key of SIGNAL_KEYS) {
    const value = source[key];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (
      trimmed === '' ||
      trimmed.length > (key === 'eventSourceUrl' || key === 'userAgent' ? 500 : 200)
    ) {
      continue;
    }
    if (!/^[\x20-\x7e]+$/.test(trimmed)) continue;
    if (key === 'eventSourceUrl' && !/^https:\/\//i.test(trimmed)) continue;
    if (key === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) continue;
    out[key] = trimmed;
  }
  return out;
}

/** Which signals an order had (never their values): the log's match-quality view. */
export function signalsPresent(signals: OrderSignals): Readonly<Record<string, boolean>> {
  return Object.fromEntries(SIGNAL_KEYS.map((key) => [key, (signals[key] ?? '') !== '']));
}

/**
 * Meta's `fbc` from a click id when the browser cookie is missing: `fb.1.<ms>.<fbclid>`, the
 * format Meta's customer-information page gives for building it server-side.
 */
export function fbcFromClickId(fbclid: string, clickedAt: Date): string {
  return `fb.1.${clickedAt.getTime()}.${fbclid}`;
}

/** The shopper as the platforms match them, from the order and the website's signals. */
export function orderTrackingUser(
  facts: OrderEventFacts,
  signals: OrderSignals,
  options: { readonly sendNameAndCity: boolean; readonly placedAt: Date },
): TrackingUser {
  const [first = '', ...rest] = (facts.name ?? '').trim().split(/\s+/);
  const fbc =
    signals.fbc ??
    (signals.fbclid === undefined ? undefined : fbcFromClickId(signals.fbclid, options.placedAt));
  return {
    phone: facts.phoneE164,
    email: facts.email ?? signals.email,
    country: 'bd',
    externalId: facts.customerId,
    ...(options.sendNameAndCity
      ? { firstName: first, lastName: rest.join(' '), city: facts.city ?? undefined }
      : {}),
    fbp: signals.fbp,
    fbc,
    clientIpAddress: signals.ip,
    clientUserAgent: signals.userAgent,
  };
}

/** The ecommerce half of an order event: value in BDT, the items by SKU code. */
export function orderCustomData(
  facts: OrderEventFacts,
  valuePoisha: Poisha,
): Record<string, unknown> {
  // At most fifty items and short names, as the website's events are bounded (the event row's
  // size check would otherwise refuse a very long order).
  const contents = facts.lines
    .filter((line) => line.qty > 0)
    .slice(0, 50)
    .map((line) => ({
      id: line.skuCode.slice(0, 80),
      quantity: line.qty,
      item_price: poishaToMajorNumber(line.unitPricePoisha),
      name: line.productName.slice(0, 200),
    }));
  return {
    currency: 'BDT',
    value: poishaToMajorNumber(valuePoisha),
    order_id: facts.orderNo,
    content_type: 'product',
    content_ids: contents.map((item) => item.id),
    contents,
    num_items: contents.reduce((total, item) => total + item.quantity, 0),
  };
}

/** What the log keeps of the shopper: masked, and which matching inputs were present. */
export function orderLogView(user: TrackingUser): {
  readonly userMasked: ReturnType<typeof trackingMaskedUser>;
  readonly matchKeys: ReturnType<typeof trackingMatchKeys>;
} {
  return { userMasked: trackingMaskedUser(user), matchKeys: trackingMatchKeys(user) };
}

/** One order event to Meta's Conversions API. Hashes only, by construction. */
export function orderMetaEvent(input: {
  readonly eventName: string;
  readonly eventId: string;
  readonly eventTime: Date;
  readonly actionSource: string;
  readonly eventSourceUrl?: string | undefined;
  readonly user: TrackingUser;
  readonly customData: Readonly<Record<string, unknown>>;
  readonly hash: TrackingHash;
  readonly defaultCountryCode: string;
}): Record<string, unknown> {
  return metaEvent({
    eventName: input.eventName,
    eventId: input.eventId,
    eventTime: Math.floor(input.eventTime.getTime() / 1000),
    eventSourceUrl: input.actionSource === 'website' ? input.eventSourceUrl : undefined,
    actionSource: input.actionSource,
    userData: metaUserData(input.user, input.hash, input.defaultCountryCode),
    customData: input.customData,
  });
}

/**
 * A GA4 client id for an order with no browser (D-966): two numbers joined by a dot, as GA4's
 * client ids are, made from the buyer's id, so one buyer is one client.
 */
export function syntheticGa4ClientId(customerId: string, hash: TrackingHash): string {
  const digest = hash(`ga4-client:${customerId.toLowerCase()}`);
  const first = BigInt(`0x${digest.slice(0, 8)}`) % 2_000_000_000n;
  const second = BigInt(`0x${digest.slice(8, 16)}`) % 2_000_000_000n;
  return `${first + 1n}.${second + 1n}`;
}

/** One order event to GA4's Measurement Protocol (`purchase`, a custom stage or `refund`). */
export function orderGa4Body(input: {
  readonly eventName: string;
  readonly eventId: string;
  readonly eventTime: Date;
  readonly clientId: string;
  readonly sessionId?: string | undefined;
  readonly customerId: string;
  readonly customData: Readonly<Record<string, unknown>>;
}): Record<string, unknown> {
  return ga4Payload({
    eventName: input.eventName,
    eventId: input.eventId,
    clientId: input.clientId,
    sessionId: input.sessionId,
    userId: input.customerId,
    customData: input.customData,
    eventTime: Math.floor(input.eventTime.getTime() / 1000),
  });
}

/** GA4's `refund` for an order: its transaction id and the amount, no items (D-967). */
export function refundCustomData(orderNo: string, refundPoisha: Poisha): Record<string, unknown> {
  return { currency: 'BDT', value: poishaToMajorNumber(refundPoisha), order_id: orderNo };
}

/** One delivery's outcome as the log shows it, from all of an event's deliveries. */
export type DeliveryStatus = 'waiting' | 'queued' | 'sent' | 'failed' | 'skipped';

export function eventStatus(statuses: readonly DeliveryStatus[]): DeliveryStatus | 'partial' {
  if (statuses.length === 0) return 'skipped';
  if (statuses.some((status) => status === 'waiting')) return 'waiting';
  if (statuses.some((status) => status === 'queued')) return 'queued';
  const attempted = statuses.filter((status) => status !== 'skipped');
  if (attempted.length === 0) return 'skipped';
  if (attempted.every((status) => status === 'sent')) return 'sent';
  if (attempted.every((status) => status === 'failed')) return 'failed';
  return 'partial';
}

/** The retries a delivery gets before it is `failed` (pg-boss retries in between). */
export const DELIVERY_MAX_ATTEMPTS = 5;

/** The signals' life (D-963). */
export const ORDER_SIGNALS_DAYS = 60;
