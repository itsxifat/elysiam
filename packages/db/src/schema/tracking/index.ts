import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { primaryId, timestamps } from '../columns.js';
import { orders } from '../orders/index.js';
import { organizations } from '../org/index.js';

/**
 * The tracking hub (M54, D-957 to D-973): one place per brand for the ad and analytics
 * platforms (Meta, GA4, TikTok, Google Ads), every order's stage events whatever its channel,
 * the website's browser events, and one delivery per event and platform.
 *
 * Tenant tables with the full treatment (invariant 4): `org_id` with RLS ENABLE and FORCE
 * (migration `*_m54_tracking_policies`), every tenant foreign key carrying `org_id` on both sides
 * (D-047). Secrets (a platform's token, API secret or key) and everything personal that is sent
 * (hashed identifiers, browser and click ids, the address and browser) are AES-256-GCM
 * ciphertext under the platform's sealed box (`STOREFRONT_CREDENTIALS_KEY`), bound to the brand,
 * the row and the field. The log keeps only a masked view and which matching inputs were there.
 */
export const tracking = pgSchema('tracking');

/** AES-256-GCM ciphertext under `STOREFRONT_CREDENTIALS_KEY` (the platform's sealed box). */
const sealedBytes = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
  fromDriver: (value) => Buffer.from(value as unknown as Uint8Array),
  toDriver: (value) => value,
});

/**
 * A brand's tracking settings (D-957): which order stage is the platforms' `Purchase`, which
 * stage events go to which platform, the website's browser-event routes and first-party paths
 * (moved from `storefront.tracking_settings`, D-961), test mode, consent and retention.
 * `imported_from` records what the one-time import found.
 */
export const trackingHubSettings = tracking.table(
  'settings',
  {
    orgId: uuid('org_id')
      .primaryKey()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    purchaseStage: text('purchase_stage').notNull().default('confirmed'),
    /** `{ <stage>: { <destination>: boolean } }`; a missing entry is on. */
    stageRoutes: jsonb('stage_routes').notNull().default({}),
    /** The website's browser events: `[{ name, enabled, client, server, meta, ga4, tiktok }]`. */
    webRoutes: jsonb('web_routes').notNull().default([]),
    proxy: jsonb('proxy').notNull().default({}),
    testMode: boolean('test_mode').notNull().default(false),
    /** The brand records consent for names and city (§11, D-256). */
    sendNameAndCity: boolean('send_name_and_city').notNull().default(false),
    /** Chat, phone and desk orders to GA4 under a made-up client id (D-966). */
    chatToGa4: boolean('chat_to_ga4').notNull().default(false),
    defaultCountryCode: text('default_country_code').notNull().default('880'),
    logRetentionDays: integer('log_retention_days').notNull().default(30),
    importedFrom: text('imported_from'),
    updatedBy: text('updated_by').notNull(),
    ...timestamps,
  },
  (table) => [
    index('tracking_settings_org_idx').on(table.orgId),
    check(
      'tracking_settings_purchase_stage',
      sql`${table.purchaseStage} in ('placed', 'confirmed', 'delivered')`,
    ),
    check('tracking_settings_country_code', sql`${table.defaultCountryCode} ~ '^[0-9]{1,4}$'`),
    check('tracking_settings_retention', sql`${table.logRetentionDays} between 1 and 365`),
    check(
      'tracking_settings_imported_from',
      sql`${table.importedFrom} is null
          or ${table.importedFrom} in ('storefront', 'marketing', 'storefront_and_marketing', 'none')`,
    ),
    check(
      'tracking_settings_sections_bounded',
      sql`pg_column_size(${table.stageRoutes}) + pg_column_size(${table.webRoutes})
          + pg_column_size(${table.proxy}) < 16384`,
    ),
  ],
);

/**
 * One platform a brand sends to (D-958: one per platform). `public_ids` holds what is not a
 * secret (a pixel or dataset id, a measurement id, a pixel code, an account id); the secret is
 * sealed, write-only and shown as a fingerprint. `enabled` is the server's sending,
 * `client_enabled` the browser's tag on the website.
 */
export const trackingDestinations = tracking.table(
  'destinations',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    kind: text('kind').notNull(),
    enabled: boolean('enabled').notNull().default(false),
    clientEnabled: boolean('client_enabled').notNull().default(false),
    publicIds: jsonb('public_ids').notNull().default({}),
    secretSealed: sealedBytes('secret_sealed'),
    secretFingerprint: text('secret_fingerprint'),
    keyId: text('key_id'),
    testCode: text('test_code').notNull().default(''),
    apiVersion: text('api_version').notNull().default(''),
    options: jsonb('options').notNull().default({}),
    lastTestAt: timestamp('last_test_at', { withTimezone: true, mode: 'date' }),
    lastTestStatus: text('last_test_status'),
    lastTestError: text('last_test_error'),
    updatedBy: text('updated_by').notNull(),
    ...timestamps,
  },
  (table) => [
    unique('destinations_org_id_id_key').on(table.orgId, table.id),
    uniqueIndex('destinations_org_kind_idx').on(table.orgId, table.kind),
    index('destinations_org_idx').on(table.orgId),
    check('destinations_kind', sql`${table.kind} in ('meta', 'ga4', 'tiktok', 'google_ads')`),
    check(
      'destinations_secret_complete',
      sql`(${table.secretSealed} is null) = (${table.secretFingerprint} is null)
          and (${table.secretSealed} is null) = (${table.keyId} is null)`,
    ),
    check('destinations_test_code', sql`${table.testCode} ~ '^[A-Za-z0-9_-]{0,64}$'`),
    check(
      'destinations_api_version',
      sql`${table.apiVersion} ~ '^(v[0-9]{1,3}([.][0-9]{1,2})?)?$'`,
    ),
    check(
      'destinations_last_test_status',
      sql`${table.lastTestStatus} is null or ${table.lastTestStatus} in ('ok', 'failed')`,
    ),
    check(
      'destinations_sections_bounded',
      sql`pg_column_size(${table.publicIds}) + pg_column_size(${table.options}) < 8192`,
    ),
  ],
);

/**
 * One event (D-959): an order's stage (`stage`), a refund GA4 is told of (`refund`), a browser
 * event the website forwarded (`browser`) or a test a person sent (`test`). The server's events
 * are unique per brand by `event_id`, so an outbox event heard twice writes one row. What goes
 * out (hashed identifiers and the ids platforms take in the clear) is sealed until every
 * delivery is final, then cleared. Deleted with its deliveries past `expires_at` (D-964).
 */
export const trackingHubEvents = tracking.table(
  'events',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    kind: text('kind').notNull(),
    eventId: text('event_id').notNull(),
    eventName: text('event_name').notNull(),
    stage: text('stage'),
    orderId: uuid('order_id'),
    valuePoisha: bigint('value_poisha', { mode: 'bigint' }),
    currency: text('currency'),
    actionSource: text('action_source'),
    userMasked: jsonb('user_masked').notNull().default({}),
    matchKeys: jsonb('match_keys').notNull().default({}),
    customData: jsonb('custom_data').notNull().default({}),
    payloadSealed: sealedBytes('payload_sealed'),
    keyId: text('key_id'),
    eventTime: timestamp('event_time', { withTimezone: true, mode: 'date' }).notNull(),
    testMode: boolean('test_mode').notNull().default(false),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    ...timestamps,
  },
  (table) => [
    unique('events_org_id_id_key').on(table.orgId, table.id),
    index('events_org_idx').on(table.orgId),
    index('events_org_created_idx').on(table.orgId, table.createdAt),
    index('events_org_order_idx').on(table.orgId, table.orderId),
    index('events_expires_idx').on(table.expiresAt),
    // The server writes each of its events once, however often it is asked to.
    uniqueIndex('events_org_server_event_idx')
      .on(table.orgId, table.eventId)
      .where(sql`${table.kind} <> 'browser'`),
    foreignKey({
      name: 'events_org_id_order_id_fk',
      columns: [table.orgId, table.orderId],
      foreignColumns: [orders.orgId, orders.id],
    }).onDelete('restrict'),
    check('events_kind', sql`${table.kind} in ('stage', 'refund', 'browser', 'test')`),
    check('events_event_id_shape', sql`${table.eventId} ~ '^[!-~]{1,100}$'`),
    check('events_event_name_shape', sql`${table.eventName} ~ '^[A-Za-z][A-Za-z0-9_]{0,39}$'`),
    check(
      'events_stage',
      sql`${table.stage} is null
          or ${table.stage} in ('placed', 'confirmed', 'delivered', 'returned', 'cancelled')`,
    ),
    check(
      'events_stage_kind',
      sql`(${table.kind} in ('stage', 'refund')) = (${table.stage} is not null)
          and (${table.kind} in ('stage', 'refund')) = (${table.orderId} is not null)`,
    ),
    check('events_value', sql`${table.valuePoisha} is null or ${table.valuePoisha} >= 0`),
    check('events_currency', sql`${table.currency} is null or ${table.currency} ~ '^[A-Z]{3}$'`),
    check('events_sealed', sql`(${table.payloadSealed} is null) or (${table.keyId} is not null)`),
    check(
      'events_bounded',
      sql`pg_column_size(${table.customData}) + pg_column_size(${table.userMasked})
          + pg_column_size(${table.matchKeys}) < 32768`,
    ),
  ],
);

/**
 * One event to one platform (D-962), its own job. `waiting` is a purchase paid online whose
 * payment is not booked yet; `sent` and `skipped` are final (trigger), and a `failed` one goes
 * back to `queued` only by Retry. `response` is the platform's summary, never personal data.
 */
export const trackingDeliveries = tracking.table(
  'deliveries',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    eventRowId: uuid('event_row_id').notNull(),
    destination: text('destination').notNull(),
    status: text('status').notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    response: jsonb('response').notNull().default({}),
    lastError: text('last_error'),
    sentAt: timestamp('sent_at', { withTimezone: true, mode: 'date' }),
    ...timestamps,
  },
  (table) => [
    unique('deliveries_org_id_id_key').on(table.orgId, table.id),
    uniqueIndex('deliveries_org_event_destination_idx').on(
      table.orgId,
      table.eventRowId,
      table.destination,
    ),
    index('deliveries_org_idx').on(table.orgId),
    index('deliveries_org_status_idx').on(table.orgId, table.status, table.createdAt),
    foreignKey({
      name: 'deliveries_org_id_event_row_id_fk',
      columns: [table.orgId, table.eventRowId],
      foreignColumns: [trackingHubEvents.orgId, trackingHubEvents.id],
    }).onDelete('cascade'),
    check(
      'deliveries_destination',
      sql`${table.destination} in ('meta', 'ga4', 'tiktok', 'google_ads')`,
    ),
    check(
      'deliveries_status',
      sql`${table.status} in ('waiting', 'queued', 'sent', 'failed', 'skipped')`,
    ),
    check('deliveries_attempts', sql`${table.attempts} >= 0`),
    check('deliveries_sent_at', sql`(${table.status} = 'sent') = (${table.sentAt} is not null)`),
    check('deliveries_response_bounded', sql`pg_column_size(${table.response}) < 4096`),
  ],
);

/**
 * What the website knew of the shopper when an order was placed (D-963): Meta's, TikTok's and
 * Google's browser and click ids, GA4's client and session, the address and browser and the
 * page, sealed, so an event sent at confirmation days later matches as well as one sent at
 * checkout. Kept 60 days, then purged.
 */
export const trackingOrderSignals = tracking.table(
  'order_signals',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    orderId: uuid('order_id').notNull(),
    signalsSealed: sealedBytes('signals_sealed').notNull(),
    keyId: text('key_id').notNull(),
    /** Which signals were there (never the values): the log's match-quality view. */
    present: jsonb('present').notNull().default({}),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    ...timestamps,
  },
  (table) => [
    primaryKey({ name: 'order_signals_pkey', columns: [table.orgId, table.orderId] }),
    index('order_signals_org_idx').on(table.orgId),
    index('order_signals_expires_idx').on(table.expiresAt),
    foreignKey({
      name: 'order_signals_org_id_order_id_fk',
      columns: [table.orgId, table.orderId],
      foreignColumns: [orders.orgId, orders.id],
    }).onDelete('restrict'),
    check('order_signals_present_bounded', sql`pg_column_size(${table.present}) < 2048`),
  ],
);
