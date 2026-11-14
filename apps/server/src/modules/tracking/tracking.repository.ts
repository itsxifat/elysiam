import type { Tx } from '@elysium/db';
import { sql, type SQL } from 'drizzle-orm';

/**
 * The tracking hub's tables (M54, schema `tracking`). Raw SQL lives here only, parameterized,
 * always inside `withOrg()` (RLS forced on every table), and always scoped by `org_id` too.
 */

// --- settings ---------------------------------------------------------------------------------

export interface SettingsRow extends Record<string, unknown> {
  readonly org_id: string;
  readonly purchase_stage: string;
  readonly stage_routes: unknown;
  readonly web_routes: unknown;
  readonly proxy: unknown;
  readonly test_mode: boolean;
  readonly send_name_and_city: boolean;
  readonly chat_to_ga4: boolean;
  readonly default_country_code: string;
  readonly log_retention_days: number;
  readonly imported_from: string | null;
  readonly updated_by: string;
  readonly updated_at: string;
}

export async function settings(tx: Tx, orgId: string): Promise<SettingsRow | undefined> {
  const rows = await tx.execute<SettingsRow>(sql`
    select org_id, purchase_stage, stage_routes, web_routes, proxy, test_mode,
           send_name_and_city, chat_to_ga4, default_country_code, log_retention_days,
           imported_from, updated_by, updated_at
    from tracking.settings where org_id = ${orgId}
  `);
  return rows[0];
}

export interface SettingsValues {
  readonly purchaseStage: string;
  readonly stageRoutes: unknown;
  readonly webRoutes: unknown;
  readonly proxy: unknown;
  readonly testMode: boolean;
  readonly sendNameAndCity: boolean;
  readonly chatToGa4: boolean;
  readonly defaultCountryCode: string;
  readonly logRetentionDays: number;
}

/** The brand's first settings row; false when another writer got there first. */
export async function insertSettings(
  tx: Tx,
  orgId: string,
  values: SettingsValues,
  importedFrom: string,
  by: string,
): Promise<boolean> {
  const rows = await tx.execute<{ org_id: string }>(sql`
    insert into tracking.settings
      (org_id, purchase_stage, stage_routes, web_routes, proxy, test_mode, send_name_and_city,
       chat_to_ga4, default_country_code, log_retention_days, imported_from, updated_by)
    values (${orgId}, ${values.purchaseStage}, ${JSON.stringify(values.stageRoutes)}::jsonb,
            ${JSON.stringify(values.webRoutes)}::jsonb, ${JSON.stringify(values.proxy)}::jsonb,
            ${values.testMode}, ${values.sendNameAndCity}, ${values.chatToGa4},
            ${values.defaultCountryCode}, ${values.logRetentionDays}, ${importedFrom}, ${by})
    on conflict (org_id) do nothing
    returning org_id
  `);
  return rows.length > 0;
}

export async function updateSettings(
  tx: Tx,
  orgId: string,
  values: SettingsValues,
  by: string,
): Promise<void> {
  await tx.execute(sql`
    update tracking.settings set
      purchase_stage = ${values.purchaseStage},
      stage_routes = ${JSON.stringify(values.stageRoutes)}::jsonb,
      web_routes = ${JSON.stringify(values.webRoutes)}::jsonb,
      proxy = ${JSON.stringify(values.proxy)}::jsonb,
      test_mode = ${values.testMode},
      send_name_and_city = ${values.sendNameAndCity},
      chat_to_ga4 = ${values.chatToGa4},
      default_country_code = ${values.defaultCountryCode},
      log_retention_days = ${values.logRetentionDays},
      updated_by = ${by},
      updated_at = now()
    where org_id = ${orgId}
  `);
}

// --- destinations -----------------------------------------------------------------------------

export interface DestinationRow extends Record<string, unknown> {
  readonly id: string;
  readonly kind: string;
  readonly enabled: boolean;
  readonly client_enabled: boolean;
  readonly public_ids: unknown;
  readonly secret_sealed: Buffer | null;
  readonly secret_fingerprint: string | null;
  readonly key_id: string | null;
  readonly test_code: string;
  readonly api_version: string;
  readonly options: unknown;
  readonly last_test_at: string | null;
  readonly last_test_status: string | null;
  readonly last_test_error: string | null;
}

const DESTINATION_COLUMNS = sql`
  id, kind, enabled, client_enabled, public_ids, secret_sealed, secret_fingerprint, key_id,
  test_code, api_version, options, last_test_at, last_test_status, last_test_error
`;

export async function destinations(tx: Tx, orgId: string): Promise<DestinationRow[]> {
  const rows = await tx.execute<DestinationRow>(sql`
    select ${DESTINATION_COLUMNS} from tracking.destinations
    where org_id = ${orgId} order by kind
  `);
  return [...rows].map(withBuffer);
}

export async function destination(
  tx: Tx,
  orgId: string,
  kind: string,
): Promise<DestinationRow | undefined> {
  const rows = await tx.execute<DestinationRow>(sql`
    select ${DESTINATION_COLUMNS} from tracking.destinations
    where org_id = ${orgId} and kind = ${kind}
  `);
  const row = rows[0];
  return row === undefined ? undefined : withBuffer(row);
}

function withBuffer(row: DestinationRow): DestinationRow {
  return {
    ...row,
    secret_sealed:
      row.secret_sealed === null ? null : Buffer.from(row.secret_sealed as unknown as Uint8Array),
  };
}

export interface DestinationValues {
  readonly kind: string;
  readonly enabled: boolean;
  readonly clientEnabled: boolean;
  readonly publicIds: Readonly<Record<string, string>>;
  /** Left out keeps the secret, null removes it. */
  readonly secret?:
    | { readonly sealed: Buffer; readonly fingerprint: string; readonly keyId: string }
    | null
    | undefined;
  readonly testCode: string;
  readonly apiVersion: string;
  readonly options: Readonly<Record<string, unknown>>;
}

export async function upsertDestination(
  tx: Tx,
  orgId: string,
  values: DestinationValues,
  by: string,
): Promise<void> {
  const keep = values.secret === undefined;
  const sealed = values.secret ?? null;
  await tx.execute(sql`
    insert into tracking.destinations
      (org_id, kind, enabled, client_enabled, public_ids, secret_sealed, secret_fingerprint,
       key_id, test_code, api_version, options, updated_by)
    values (${orgId}, ${values.kind}, ${values.enabled}, ${values.clientEnabled},
            ${JSON.stringify(values.publicIds)}::jsonb, ${sealed?.sealed ?? null},
            ${sealed?.fingerprint ?? null}, ${sealed?.keyId ?? null}, ${values.testCode},
            ${values.apiVersion}, ${JSON.stringify(values.options)}::jsonb, ${by})
    on conflict (org_id, kind) do update set
      enabled = excluded.enabled,
      client_enabled = excluded.client_enabled,
      public_ids = excluded.public_ids,
      secret_sealed = case when ${keep} then tracking.destinations.secret_sealed
                           else excluded.secret_sealed end,
      secret_fingerprint = case when ${keep} then tracking.destinations.secret_fingerprint
                                else excluded.secret_fingerprint end,
      key_id = case when ${keep} then tracking.destinations.key_id else excluded.key_id end,
      test_code = excluded.test_code,
      api_version = excluded.api_version,
      options = excluded.options,
      updated_by = excluded.updated_by,
      updated_at = now()
  `);
}

export async function recordDestinationTest(
  tx: Tx,
  orgId: string,
  kind: string,
  outcome: { readonly ok: boolean; readonly error: string | null },
): Promise<void> {
  await tx.execute(sql`
    update tracking.destinations set
      last_test_at = now(),
      last_test_status = ${outcome.ok ? 'ok' : 'failed'},
      last_test_error = ${outcome.error === null ? null : outcome.error.slice(0, 500)}
    where org_id = ${orgId} and kind = ${kind}
  `);
}

// --- events and deliveries --------------------------------------------------------------------

export interface EventValues {
  readonly id: string;
  readonly kind: 'stage' | 'refund' | 'browser' | 'test';
  readonly eventId: string;
  readonly eventName: string;
  readonly stage: string | null;
  readonly orderId: string | null;
  readonly valuePoisha: bigint | null;
  readonly currency: string | null;
  readonly actionSource: string | null;
  readonly userMasked: unknown;
  readonly matchKeys: unknown;
  readonly customData: unknown;
  readonly payload: { readonly sealed: Buffer; readonly keyId: string };
  readonly eventTime: Date;
  readonly testMode: boolean;
  readonly retentionDays: number;
}

/**
 * One event, once: a server event already written (the same id) writes nothing and answers
 * false, so an outbox event heard twice is one event (D-959).
 */
export async function insertEvent(tx: Tx, orgId: string, values: EventValues): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into tracking.events
      (id, org_id, kind, event_id, event_name, stage, order_id, value_poisha, currency,
       action_source, user_masked, match_keys, custom_data, payload_sealed, key_id, event_time,
       test_mode, expires_at)
    values (${values.id}, ${orgId}, ${values.kind}, ${values.eventId}, ${values.eventName},
            ${values.stage}, ${values.orderId},
            ${values.valuePoisha === null ? null : values.valuePoisha.toString()},
            ${values.currency}, ${values.actionSource}, ${JSON.stringify(values.userMasked)}::jsonb,
            ${JSON.stringify(values.matchKeys)}::jsonb, ${JSON.stringify(values.customData)}::jsonb,
            ${values.payload.sealed}, ${values.payload.keyId}, ${values.eventTime.toISOString()},
            ${values.testMode}, now() + make_interval(days => ${values.retentionDays}))
    on conflict (org_id, event_id) where kind <> 'browser' do nothing
    returning id
  `);
  return rows.length > 0;
}

export async function insertDelivery(
  tx: Tx,
  orgId: string,
  eventRowId: string,
  destination: string,
  status: 'queued' | 'waiting' | 'skipped',
  reason: string | null,
): Promise<string | undefined> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into tracking.deliveries (org_id, event_row_id, destination, status, last_error)
    values (${orgId}, ${eventRowId}, ${destination}, ${status}, ${reason})
    on conflict (org_id, event_row_id, destination) do nothing
    returning id
  `);
  return rows[0]?.id;
}

export interface EventLookupRow extends Record<string, unknown> {
  readonly id: string;
  readonly event_name: string;
  readonly value_poisha: string | null;
}

export async function eventByEventId(
  tx: Tx,
  orgId: string,
  eventId: string,
): Promise<EventLookupRow | undefined> {
  const rows = await tx.execute<EventLookupRow>(sql`
    select id, event_name, value_poisha from tracking.events
    where org_id = ${orgId} and event_id = ${eventId} and kind <> 'browser'
  `);
  return rows[0];
}

/** Whether a purchase reached GA4 or is on its way there (a refund for it then makes sense). */
export async function ga4PurchaseOf(
  tx: Tx,
  orgId: string,
  eventId: string,
): Promise<{ readonly valuePoisha: bigint } | undefined> {
  const rows = await tx.execute<{ value_poisha: string | null }>(sql`
    select e.value_poisha from tracking.events e
    join tracking.deliveries d on d.org_id = e.org_id and d.event_row_id = e.id
    where e.org_id = ${orgId} and e.event_id = ${eventId} and e.kind = 'stage'
      and d.destination = 'ga4' and d.status in ('queued', 'sent')
    for update of e
  `);
  const row = rows[0];
  return row === undefined ? undefined : { valuePoisha: BigInt(row.value_poisha ?? '0') };
}

export async function refundedFor(tx: Tx, orgId: string, orderId: string): Promise<bigint> {
  const rows = await tx.execute<{ total: string | null }>(sql`
    select sum(value_poisha)::text as total from tracking.events
    where org_id = ${orgId} and order_id = ${orderId} and kind = 'refund'
  `);
  return BigInt(rows[0]?.total ?? '0');
}

export interface SendRow extends Record<string, unknown> {
  readonly delivery_id: string;
  readonly destination: string;
  readonly status: string;
  readonly attempts: number;
  readonly event_row_id: string;
  readonly kind: string;
  readonly event_id: string;
  readonly event_name: string;
  readonly order_id: string | null;
  readonly custom_data: unknown;
  readonly action_source: string | null;
  readonly payload_sealed: Buffer | null;
  readonly event_time: string;
  readonly test_mode: boolean;
}

export async function deliveryForSend(
  tx: Tx,
  orgId: string,
  deliveryId: string,
): Promise<SendRow | undefined> {
  const rows = await tx.execute<SendRow>(sql`
    select d.id as delivery_id, d.destination, d.status, d.attempts, e.id as event_row_id,
           e.kind, e.event_id, e.event_name, e.order_id, e.custom_data, e.action_source,
           e.payload_sealed, e.event_time, e.test_mode
    from tracking.deliveries d
    join tracking.events e on e.org_id = d.org_id and e.id = d.event_row_id
    where d.org_id = ${orgId} and d.id = ${deliveryId}
    for update of d
  `);
  const row = rows[0];
  if (row === undefined) return undefined;
  return {
    ...row,
    payload_sealed:
      row.payload_sealed === null ? null : Buffer.from(row.payload_sealed as unknown as Uint8Array),
  };
}

export async function finishDelivery(
  tx: Tx,
  orgId: string,
  deliveryId: string,
  outcome: {
    readonly status: 'queued' | 'sent' | 'failed' | 'skipped';
    readonly attempts: number;
    readonly response: Readonly<Record<string, unknown>>;
    readonly error: string | null;
  },
): Promise<void> {
  await tx.execute(sql`
    update tracking.deliveries set
      status = ${outcome.status},
      attempts = ${outcome.attempts},
      response = ${JSON.stringify(outcome.response)}::jsonb,
      last_error = ${outcome.error === null ? null : outcome.error.slice(0, 500)},
      sent_at = case when ${outcome.status} = 'sent' then now() else null end,
      updated_at = now()
    where org_id = ${orgId} and id = ${deliveryId}
  `);
}

/** Once every delivery of an event is sent or skipped, nothing personal is kept for it. */
export async function clearPayloadIfDone(tx: Tx, orgId: string, eventRowId: string): Promise<void> {
  await tx.execute(sql`
    update tracking.events set payload_sealed = null, key_id = null, updated_at = now()
    where org_id = ${orgId} and id = ${eventRowId} and payload_sealed is not null
      and not exists (
        select 1 from tracking.deliveries d
        where d.org_id = ${orgId} and d.event_row_id = ${eventRowId}
          and d.status not in ('sent', 'skipped')
      )
  `);
}

/** Retry: a failed delivery goes back to queued; anything else is left alone. */
export async function requeueFailed(
  tx: Tx,
  orgId: string,
  deliveryId: string,
): Promise<{ readonly ok: boolean; readonly exists: boolean }> {
  const found = await tx.execute<{ status: string }>(sql`
    select status from tracking.deliveries where org_id = ${orgId} and id = ${deliveryId}
    for update
  `);
  const row = found[0];
  if (row === undefined) return { ok: false, exists: false };
  if (row.status !== 'failed') return { ok: false, exists: true };
  await tx.execute(sql`
    update tracking.deliveries set status = 'queued', last_error = null, updated_at = now()
    where org_id = ${orgId} and id = ${deliveryId}
  `);
  return { ok: true, exists: true };
}

/** An order's waiting deliveries (a purchase paid online), moved to queued. */
export async function releaseWaiting(tx: Tx, orgId: string, orderId: string): Promise<string[]> {
  const rows = await tx.execute<{ id: string }>(sql`
    update tracking.deliveries d set status = 'queued', updated_at = now()
    from tracking.events e
    where d.org_id = ${orgId} and e.org_id = ${orgId} and e.id = d.event_row_id
      and e.order_id = ${orderId} and d.status = 'waiting'
    returning d.id
  `);
  return [...rows].map((row) => row.id);
}

/** A cancelled order's purchase that waited for an online payment never goes. */
export async function skipWaiting(tx: Tx, orgId: string, orderId: string): Promise<void> {
  await tx.execute(sql`
    update tracking.deliveries d
    set status = 'skipped', last_error = 'The online payment never came.', updated_at = now()
    from tracking.events e
    where d.org_id = ${orgId} and e.org_id = ${orgId} and e.id = d.event_row_id
      and e.order_id = ${orderId} and d.status = 'waiting'
  `);
}

// --- the website's signals ----------------------------------------------------------------------

export async function upsertSignals(
  tx: Tx,
  orgId: string,
  orderId: string,
  values: {
    readonly sealed: Buffer;
    readonly keyId: string;
    readonly present: Readonly<Record<string, boolean>>;
    readonly days: number;
  },
): Promise<void> {
  await tx.execute(sql`
    insert into tracking.order_signals (org_id, order_id, signals_sealed, key_id, present, expires_at)
    values (${orgId}, ${orderId}, ${values.sealed}, ${values.keyId},
            ${JSON.stringify(values.present)}::jsonb, now() + make_interval(days => ${values.days}))
    on conflict (org_id, order_id) do update set
      signals_sealed = excluded.signals_sealed,
      key_id = excluded.key_id,
      present = excluded.present,
      updated_at = now()
  `);
}

export async function setAwaitingPayment(
  tx: Tx,
  orgId: string,
  orderId: string,
  awaiting: boolean,
): Promise<void> {
  await tx.execute(sql`
    update tracking.order_signals
    set present = jsonb_set(present, '{awaitingPayment}', to_jsonb(${awaiting}::boolean)),
        updated_at = now()
    where org_id = ${orgId} and order_id = ${orderId}
  `);
}

export interface SignalsRow extends Record<string, unknown> {
  readonly signals_sealed: Buffer;
  readonly present: unknown;
}

export async function signals(
  tx: Tx,
  orgId: string,
  orderId: string,
): Promise<SignalsRow | undefined> {
  const rows = await tx.execute<SignalsRow>(sql`
    select signals_sealed, present from tracking.order_signals
    where org_id = ${orgId} and order_id = ${orderId} and expires_at > now()
    for share
  `);
  const row = rows[0];
  if (row === undefined) return undefined;
  return { ...row, signals_sealed: Buffer.from(row.signals_sealed as unknown as Uint8Array) };
}

// --- the log ----------------------------------------------------------------------------------

export interface LogRow extends Record<string, unknown> {
  readonly id: string;
  readonly kind: string;
  readonly event_id: string;
  readonly event_name: string;
  readonly stage: string | null;
  readonly order_id: string | null;
  readonly custom_data: unknown;
  readonly value_poisha: string | null;
  readonly currency: string | null;
  readonly action_source: string | null;
  readonly user_masked: unknown;
  readonly match_keys: unknown;
  readonly test_mode: boolean;
  readonly event_time: string;
  readonly created_at: string;
  readonly deliveries: unknown;
}

export async function logPage(
  tx: Tx,
  orgId: string,
  filters: {
    readonly stage?: string | undefined;
    readonly kind?: string | undefined;
    readonly destination?: string | undefined;
    readonly status?: string | undefined;
    readonly orderId?: string | undefined;
    readonly before: { readonly createdAt: string; readonly id: string } | null;
    readonly limit: number;
  },
): Promise<LogRow[]> {
  const where: SQL[] = [sql`e.org_id = ${orgId}`];
  if (filters.stage !== undefined) where.push(sql`e.stage = ${filters.stage}`);
  if (filters.kind !== undefined) where.push(sql`e.kind = ${filters.kind}`);
  if (filters.orderId !== undefined) where.push(sql`e.order_id = ${filters.orderId}`);
  if (filters.destination !== undefined || filters.status !== undefined) {
    where.push(sql`exists (
      select 1 from tracking.deliveries f
      where f.org_id = e.org_id and f.event_row_id = e.id
        ${filters.destination === undefined ? sql`` : sql`and f.destination = ${filters.destination}`}
        ${filters.status === undefined ? sql`` : sql`and f.status = ${filters.status}`}
    )`);
  }
  if (filters.before !== null) {
    where.push(
      sql`(e.created_at, e.id) < (${filters.before.createdAt}::timestamptz, ${filters.before.id}::uuid)`,
    );
  }
  const rows = await tx.execute<LogRow>(sql`
    select e.id, e.kind, e.event_id, e.event_name, e.stage, e.order_id, e.custom_data,
           e.value_poisha, e.currency, e.action_source, e.user_masked, e.match_keys, e.test_mode,
           e.event_time, e.created_at,
           coalesce((
             select json_agg(json_build_object(
                      'id', d.id, 'destination', d.destination, 'status', d.status,
                      'attempts', d.attempts, 'error', d.last_error, 'detail', d.response,
                      'sentAt', d.sent_at) order by d.destination)
             from tracking.deliveries d
             where d.org_id = e.org_id and d.event_row_id = e.id
           ), '[]'::json) as deliveries
    from tracking.events e
    where ${sql.join(where, sql` and `)}
    order by e.created_at desc, e.id desc
    limit ${filters.limit}
  `);
  return [...rows];
}

export interface SummaryRow extends Record<string, unknown> {
  readonly destination: string;
  readonly status: string;
  readonly count: number;
  readonly match_keys: unknown;
}

/** Per destination and status since a time, with the sent events' match keys counted. */
export async function summary(tx: Tx, orgId: string, since: Date): Promise<SummaryRow[]> {
  const rows = await tx.execute<SummaryRow>(sql`
    select d.destination, d.status, count(*)::int as count,
           coalesce((
             select json_object_agg(k.key, k.n) from (
               select key, count(*)::int as n
               from tracking.deliveries d2
               join tracking.events e2 on e2.org_id = d2.org_id and e2.id = d2.event_row_id
               cross join lateral jsonb_each(e2.match_keys) as m(key, value)
               where d2.org_id = ${orgId} and d2.destination = d.destination
                 and d2.status = 'sent' and e2.created_at >= ${since.toISOString()}
                 and m.value = 'true'::jsonb
               group by key
             ) k
           ), '{}'::json) as match_keys
    from tracking.deliveries d
    join tracking.events e on e.org_id = d.org_id and e.id = d.event_row_id
    where d.org_id = ${orgId} and e.created_at >= ${since.toISOString()}
    group by d.destination, d.status
  `);
  return [...rows];
}

/** The nightly purge (D-963, D-964): events past their brand's retention, signals past 60 days. */
export async function purge(tx: Tx, orgId: string): Promise<number> {
  const removed = await tx.execute<{ id: string }>(sql`
    delete from tracking.events e
    where e.org_id = ${orgId} and e.expires_at < now()
      -- An order's events go together, so a refund never forgets an earlier one (W4).
      and (e.order_id is null or not exists (
        select 1 from tracking.events k
        where k.org_id = e.org_id and k.order_id = e.order_id and k.expires_at >= now()
      ))
    returning e.id
  `);
  const signals = await tx.execute<{ order_id: string }>(sql`
    delete from tracking.order_signals where org_id = ${orgId} and expires_at < now()
    returning order_id
  `);
  return removed.length + signals.length;
}
