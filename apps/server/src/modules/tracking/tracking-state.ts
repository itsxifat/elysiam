import type {
  TrackingDestinationKind,
  TrackingDestinationView,
  TrackingSettingsView,
  TrackingWebRoute,
} from '@elysium/contracts/tracking';
import { TRACKING_DESTINATION_KINDS } from '@elysium/contracts/tracking';
import { retentionDays, TRACKING_STANDARD_EVENTS } from '@elysium/domain/storefront';
import {
  cleanStageRoutes,
  DEFAULT_PURCHASE_STAGE,
  PURCHASE_STAGES,
  type DestinationState,
  type PurchaseStage,
  type StageRoutes,
} from '@elysium/domain/tracking';

import type { DestinationRow, SettingsRow, SettingsValues } from './tracking.repository.js';

/**
 * The tracking hub's settings as the services use them (M54): the stored rows read with their
 * defaults, each destination's readiness, and the sealed box's bindings. Pure.
 */

export const DEFAULT_PROXY = {
  metaScriptPath: '/e1/s.js',
  metaCollectPath: '/e1/t',
  ga4ScriptPath: '/e2/s.js',
  ga4CollectPath: '/e2',
} as const;

/** Meta's Graph API version for a new destination (the newest its changelog names, 2026-11-10). */
export const DEFAULT_META_API_VERSION = 'v27.0';

/** The platforms M54a sends to; TikTok and Google Ads arrive in M54b. */
export const AVAILABLE_DESTINATIONS: readonly TrackingDestinationKind[] = ['meta', 'ga4'];

export function defaultWebRoutes(): TrackingWebRoute[] {
  return [...TRACKING_STANDARD_EVENTS, 'OrderPlaced'].map((name) => ({
    name,
    enabled: true,
    client: true,
    server: true,
    meta: true,
    ga4: true,
    tiktok: true,
  }));
}

export function webRoutesOf(value: unknown): TrackingWebRoute[] {
  if (!Array.isArray(value)) return defaultWebRoutes();
  return (value as unknown[]).flatMap((entry) => {
    const route = entry as Partial<TrackingWebRoute> | null;
    if (route === null || typeof route.name !== 'string') return [];
    return [
      {
        name: route.name,
        enabled: route.enabled !== false,
        client: route.client !== false,
        server: route.server !== false,
        meta: route.meta !== false,
        ga4: route.ga4 !== false,
        tiktok: route.tiktok !== false,
      },
    ];
  });
}

export function proxyOf(value: unknown): Record<keyof typeof DEFAULT_PROXY, string> {
  const given = (value !== null && typeof value === 'object' ? value : {}) as Partial<
    Record<keyof typeof DEFAULT_PROXY, unknown>
  >;
  const pick = (key: keyof typeof DEFAULT_PROXY): string => {
    const value = given[key];
    return typeof value === 'string' && value !== '' ? value : DEFAULT_PROXY[key];
  };
  return {
    metaScriptPath: pick('metaScriptPath'),
    metaCollectPath: pick('metaCollectPath'),
    ga4ScriptPath: pick('ga4ScriptPath'),
    ga4CollectPath: pick('ga4CollectPath'),
  };
}

function purchaseStageOf(value: string | undefined): PurchaseStage {
  return (PURCHASE_STAGES as readonly string[]).includes(value ?? '')
    ? (value as PurchaseStage)
    : DEFAULT_PURCHASE_STAGE;
}

/** The settings in force: the row, or a brand's defaults before it has one. */
export interface HubSettings {
  readonly purchaseStage: PurchaseStage;
  readonly stageRoutes: StageRoutes;
  readonly webRoutes: TrackingWebRoute[];
  readonly proxy: Record<keyof typeof DEFAULT_PROXY, string>;
  readonly testMode: boolean;
  readonly sendNameAndCity: boolean;
  readonly chatToGa4: boolean;
  readonly defaultCountryCode: string;
  readonly logRetentionDays: number;
  readonly importedFrom: string | null;
  readonly updatedAt: string | null;
}

export function hubSettings(row: SettingsRow | undefined): HubSettings {
  return {
    purchaseStage: purchaseStageOf(row?.purchase_stage),
    stageRoutes: cleanStageRoutes(row?.stage_routes),
    webRoutes: row === undefined ? defaultWebRoutes() : webRoutesOf(row.web_routes),
    proxy: proxyOf(row?.proxy),
    testMode: row?.test_mode ?? false,
    sendNameAndCity: row?.send_name_and_city ?? false,
    chatToGa4: row?.chat_to_ga4 ?? false,
    defaultCountryCode: row?.default_country_code ?? '880',
    logRetentionDays: retentionDays(row?.log_retention_days ?? 30),
    importedFrom: row?.imported_from ?? null,
    updatedAt: row === undefined ? null : new Date(row.updated_at).toISOString(),
  };
}

export function settingsView(settings: HubSettings): TrackingSettingsView {
  return {
    purchaseStage: settings.purchaseStage,
    stageRoutes: settings.stageRoutes,
    webRoutes: settings.webRoutes,
    proxy: settings.proxy,
    testMode: settings.testMode,
    sendNameAndCity: settings.sendNameAndCity,
    chatToGa4: settings.chatToGa4,
    defaultCountryCode: settings.defaultCountryCode,
    logRetentionDays: settings.logRetentionDays,
    importedFrom: settings.importedFrom,
    updatedAt: settings.updatedAt,
  };
}

export function settingsValues(settings: HubSettings): SettingsValues {
  return {
    purchaseStage: settings.purchaseStage,
    stageRoutes: settings.stageRoutes,
    webRoutes: settings.webRoutes,
    proxy: settings.proxy,
    testMode: settings.testMode,
    sendNameAndCity: settings.sendNameAndCity,
    chatToGa4: settings.chatToGa4,
    defaultCountryCode: settings.defaultCountryCode,
    logRetentionDays: settings.logRetentionDays,
  };
}

/** A destination's ids, cut to printable strings. */
export function publicIdsOf(row: DestinationRow | undefined): Record<string, string> {
  const source =
    row !== undefined && row.public_ids !== null && typeof row.public_ids === 'object'
      ? (row.public_ids as Record<string, unknown>)
      : {};
  return Object.fromEntries(
    Object.entries(source).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

/** Where Meta's events go: the dataset, or the pixel when the brand gave no dataset. */
export function metaTarget(ids: Readonly<Record<string, string>>): string {
  return (ids.datasetId ?? '') !== '' ? (ids.datasetId ?? '') : (ids.pixelId ?? '');
}

/** Its ids and secret are all there, so something can be sent (D-958). */
export function destinationReady(row: DestinationRow | undefined): boolean {
  if (row?.secret_sealed == null) return false;
  if (!AVAILABLE_DESTINATIONS.includes(row.kind as TrackingDestinationKind)) return false;
  const ids = publicIdsOf(row);
  switch (row.kind) {
    case 'meta':
      return metaTarget(ids) !== '';
    case 'ga4':
      return (ids.measurementId ?? '') !== '';
    default:
      return false;
  }
}

export function destinationStates(rows: readonly DestinationRow[]): DestinationState[] {
  return rows
    .filter((row) => (TRACKING_DESTINATION_KINDS as readonly string[]).includes(row.kind))
    .map((row) => ({
      kind: row.kind as TrackingDestinationKind,
      enabled: row.enabled,
      ready: destinationReady(row),
    }));
}

export function destinationView(
  kind: TrackingDestinationKind,
  row: DestinationRow | undefined,
): TrackingDestinationView {
  return {
    kind,
    enabled: row?.enabled ?? false,
    clientEnabled: row?.client_enabled ?? false,
    publicIds: publicIdsOf(row),
    secretSet: row?.secret_fingerprint != null,
    secretFingerprint: row?.secret_fingerprint ?? null,
    testCode: row?.test_code ?? '',
    apiVersion: row?.api_version ?? (kind === 'meta' ? DEFAULT_META_API_VERSION : ''),
    ready: destinationReady(row),
    available: AVAILABLE_DESTINATIONS.includes(kind),
    lastTestAt: row?.last_test_at == null ? null : new Date(row.last_test_at).toISOString(),
    lastTestStatus:
      row?.last_test_status === 'ok' || row?.last_test_status === 'failed'
        ? row.last_test_status
        : null,
    lastTestError: row?.last_test_error ?? null,
  };
}

/** The sealed box's bindings: a value copied into another row or field does not open. */
export const bindings = {
  secret: (orgId: string, kind: string) => ({
    orgId,
    row: `tracking.destinations:${kind}`,
    field: 'secret',
  }),
  payload: (orgId: string, eventRowId: string) => ({
    orgId,
    row: `tracking.events:${eventRowId}`,
    field: 'payload',
  }),
  signals: (orgId: string, orderId: string) => ({
    orgId,
    row: `tracking.order_signals:${orderId}`,
    field: 'signals',
  }),
};
