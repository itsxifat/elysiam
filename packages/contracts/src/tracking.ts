import { z } from 'zod';

/**
 * The tracking hub (M54, D-957 to D-973): Settings → Tracking's settings and destinations, the
 * event log's filters, and the answers' shapes. No shape here ever carries a secret back: a
 * secret is written (a string replaces it, null removes it, left out keeps it) and read as
 * "set" with its fingerprint.
 */

export const TRACKING_DESTINATION_KINDS = ['meta', 'ga4', 'tiktok', 'google_ads'] as const;
export type TrackingDestinationKind = (typeof TRACKING_DESTINATION_KINDS)[number];

export const TRACKING_ORDER_STAGES = [
  'placed',
  'confirmed',
  'delivered',
  'returned',
  'cancelled',
] as const;
export type TrackingOrderStage = (typeof TRACKING_ORDER_STAGES)[number];

export const TRACKING_PURCHASE_STAGES = ['placed', 'confirmed', 'delivered'] as const;
export type TrackingPurchaseStage = (typeof TRACKING_PURCHASE_STAGES)[number];

export const TRACKING_DELIVERY_STATUSES = [
  'waiting',
  'queued',
  'sent',
  'failed',
  'skipped',
] as const;
export type TrackingDeliveryStatus = (typeof TRACKING_DELIVERY_STATUSES)[number];

const flag = z.boolean();
const uuid = z.string().uuid('No such record.');

const eventName = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/, 'An event name: letters, digits and underscores.');

/** A path on the website (its nginx proxies the pixel and the tag through it). */
const sitePath = z
  .string()
  .trim()
  .max(80)
  .regex(/^\/[A-Za-z0-9._~\-/]*$/, 'A path on the site, starting with /.');

/** One browser event's route: on at all, from the browser, from the server, to which platform. */
export const trackingWebRouteSchema = z
  .object({
    name: eventName,
    enabled: flag,
    client: flag,
    server: flag,
    meta: flag,
    ga4: flag,
    tiktok: flag,
  })
  .strict();

export type TrackingWebRoute = z.infer<typeof trackingWebRouteSchema>;

const stageRow = z
  .object({ meta: flag, ga4: flag, tiktok: flag, google_ads: flag })
  .partial()
  .strict();

export const trackingSettingsInputSchema = z
  .object({
    purchaseStage: z.enum(TRACKING_PURCHASE_STAGES),
    stageRoutes: z
      .object({
        placed: stageRow,
        confirmed: stageRow,
        delivered: stageRow,
        returned: stageRow,
        cancelled: stageRow,
      })
      .partial()
      .strict(),
    webRoutes: z.array(trackingWebRouteSchema).max(40),
    proxy: z
      .object({
        metaScriptPath: sitePath,
        metaCollectPath: sitePath,
        ga4ScriptPath: sitePath,
        ga4CollectPath: sitePath,
      })
      .strict(),
    testMode: flag,
    sendNameAndCity: flag,
    chatToGa4: flag,
    defaultCountryCode: z.string().regex(/^\d{1,4}$/, 'A country calling code, like 880.'),
    logRetentionDays: z.number().int().min(1).max(365),
  })
  .strict()
  .refine(
    (settings) =>
      new Set(settings.webRoutes.map((route) => route.name)).size === settings.webRoutes.length,
    { message: 'Each event is listed once.', path: ['webRoutes'] },
  );

export type TrackingHubSettingsInput = z.infer<typeof trackingSettingsInputSchema>;

/** A write-only secret: left out keeps it, null removes it, a string replaces it. */
const secret = (min: number, max: number) =>
  z
    .union([
      z.null(),
      z
        .string()
        .trim()
        .min(min, 'Paste the whole value.')
        .max(max)
        .regex(/^[\x21-\x7e]+$/, 'No spaces.'),
    ])
    .optional();

const digits = (max: number) =>
  z.union([z.literal(''), z.string().regex(new RegExp(`^\\d{1,${String(max)}}$`), 'Digits only.')]);

const testCode = z.union([
  z.literal(''),
  z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'Letters, digits, - and _ only.'),
]);

export const metaDestinationSchema = z
  .object({
    kind: z.literal('meta'),
    enabled: flag,
    /** The pixel on the website. */
    clientEnabled: flag,
    pixelId: digits(24),
    /** Defaults to the pixel. */
    datasetId: digits(24),
    apiVersion: z.string().regex(/^v\d{1,3}\.\d$/, 'A Graph API version, like v27.0.'),
    accessToken: secret(20, 600),
    testCode,
  })
  .strict();

export const ga4DestinationSchema = z
  .object({
    kind: z.literal('ga4'),
    enabled: flag,
    /** The tag on the website. */
    clientEnabled: flag,
    measurementId: z.union([
      z.literal(''),
      z.string().regex(/^G-[A-Z0-9]{4,20}$/, 'A measurement id, like G-XXXXXXX.'),
    ]),
    apiSecret: secret(8, 120),
  })
  .strict();

export const trackingDestinationInputSchema = z.discriminatedUnion('kind', [
  metaDestinationSchema,
  ga4DestinationSchema,
]);

export type TrackingDestinationInput = z.infer<typeof trackingDestinationInputSchema>;

export const trackingLogQuerySchema = z
  .object({
    stage: z.enum(TRACKING_ORDER_STAGES).optional(),
    kind: z.enum(['stage', 'refund', 'browser', 'test']).optional(),
    destination: z.enum(TRACKING_DESTINATION_KINDS).optional(),
    status: z.enum(TRACKING_DELIVERY_STATUSES).optional(),
    orderId: uuid.optional(),
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export type TrackingLogQuery = z.infer<typeof trackingLogQuerySchema>;

// --- answers ---------------------------------------------------------------------------------

export interface TrackingSettingsView {
  readonly purchaseStage: TrackingPurchaseStage;
  readonly stageRoutes: Partial<
    Record<TrackingOrderStage, Partial<Record<TrackingDestinationKind, boolean>>>
  >;
  readonly webRoutes: readonly TrackingWebRoute[];
  readonly proxy: {
    readonly metaScriptPath: string;
    readonly metaCollectPath: string;
    readonly ga4ScriptPath: string;
    readonly ga4CollectPath: string;
  };
  readonly testMode: boolean;
  readonly sendNameAndCity: boolean;
  readonly chatToGa4: boolean;
  readonly defaultCountryCode: string;
  readonly logRetentionDays: number;
  readonly importedFrom: string | null;
  readonly updatedAt: string | null;
}

export interface TrackingDestinationView {
  readonly kind: TrackingDestinationKind;
  readonly enabled: boolean;
  readonly clientEnabled: boolean;
  /** Not secrets: a pixel or dataset id, a measurement id. */
  readonly publicIds: Readonly<Record<string, string>>;
  readonly secretSet: boolean;
  readonly secretFingerprint: string | null;
  readonly testCode: string;
  readonly apiVersion: string;
  /** Its ids and secret are all there, so something can be sent. */
  readonly ready: boolean;
  /** M54b's platforms are listed but cannot be set up yet. */
  readonly available: boolean;
  readonly lastTestAt: string | null;
  readonly lastTestStatus: 'ok' | 'failed' | null;
  readonly lastTestError: string | null;
}

export interface TrackingSetupView {
  readonly settings: TrackingSettingsView;
  readonly destinations: readonly TrackingDestinationView[];
  /** `live` or `fake`, so nobody mistakes one for the other. */
  readonly provider: 'live' | 'fake';
  /** The server can keep secrets and personal data sealed. */
  readonly credentialsKey: boolean;
}

export interface TrackingDeliveryView {
  readonly id: string;
  readonly destination: TrackingDestinationKind;
  readonly status: TrackingDeliveryStatus;
  readonly attempts: number;
  readonly error: string | null;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly sentAt: string | null;
}

export interface TrackingEventView {
  readonly id: string;
  readonly kind: 'stage' | 'refund' | 'browser' | 'test';
  readonly eventId: string;
  readonly eventName: string;
  readonly stage: TrackingOrderStage | null;
  readonly orderId: string | null;
  readonly orderNo: string | null;
  /** Poisha as a string; null for an event with no value. */
  readonly value: string | null;
  readonly currency: string | null;
  readonly actionSource: string | null;
  readonly user: { readonly email: string; readonly phone: string };
  readonly matchKeys: Readonly<Record<string, boolean>>;
  readonly testMode: boolean;
  readonly eventTime: string;
  readonly createdAt: string;
  readonly status: TrackingDeliveryStatus | 'partial';
  readonly deliveries: readonly TrackingDeliveryView[];
}

export interface TrackingLogPage {
  readonly items: readonly TrackingEventView[];
  readonly nextCursor: string | null;
}

export interface TrackingDestinationWeek {
  readonly destination: TrackingDestinationKind;
  readonly sent: number;
  readonly failed: number;
  readonly skipped: number;
  readonly waiting: number;
  /** Of the events sent, how many carried each matching input. */
  readonly matchKeys: Readonly<Record<string, number>>;
}

export interface TrackingSummary {
  readonly since: string;
  readonly destinations: readonly TrackingDestinationWeek[];
}

export interface TrackingTestResult {
  readonly ok: boolean;
  readonly error: string | null;
  readonly detail: Readonly<Record<string, unknown>>;
}
