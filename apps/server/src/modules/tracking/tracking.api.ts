import { Injectable } from '@nestjs/common';
import type { Tx } from '@elysium/db';
import type { OrderSignals } from '@elysium/domain/tracking';

/**
 * What other modules may ask of the tracking hub (M54, D-959; invariant 12).
 *
 * - The website's checkout hands over what it knew of the shopper (`recordOrderSignals`) in the
 *   order's own transaction, and its payments say when an online payment is booked
 *   (`paymentBooked`), so a Purchase sent at placement never goes unpaid (D-552's rule).
 * - The website's server forwards browser events (`ingestBrowserEvents`) and reads the browser's
 *   config (`clientConfig`); both open their own transaction.
 * - Storefront and marketing hand over their old settings once (`TrackingLegacySources`, D-961).
 */
export const TRACKING_API = Symbol('TrackingApi');

export interface BrowserEventInput {
  readonly eventName: string;
  readonly eventId?: string | undefined;
  readonly eventTime?: number | undefined;
  readonly eventSourceUrl?: string | undefined;
  readonly actionSource?: string | undefined;
  readonly userData?: Readonly<Record<string, string | undefined>> | undefined;
  readonly customData?: Readonly<Record<string, unknown>> | undefined;
  readonly ga4?:
    | {
        readonly clientId?: string | undefined;
        readonly sessionId?: string | undefined;
        readonly userId?: string | undefined;
        readonly params?: Readonly<Record<string, string | number | boolean>> | undefined;
      }
    | undefined;
}

export interface BrowserEventsInput {
  readonly events: readonly BrowserEventInput[];
  readonly client?: { readonly ip: string; readonly userAgent?: string | undefined } | undefined;
}

export interface BrowserEventsResult {
  readonly ok: true;
  readonly results: readonly { readonly eventId: string; readonly status: 'queued' | 'skipped' }[];
}

/** What the website's browser helper needs: the pixel, the measurement id, the paths. */
export interface TrackingClientConfig {
  readonly tracking: {
    readonly meta: { readonly pixelEnabled: boolean; readonly pixelId: string };
    readonly ga4: { readonly clientEnabled: boolean; readonly measurementId: string };
    readonly proxy: {
      readonly metaScriptPath: string;
      readonly metaCollectPath: string;
      readonly ga4ScriptPath: string;
      readonly ga4CollectPath: string;
    };
    readonly testMode: boolean;
    /** D-965: the browser fires `Purchase` only when this is `placed`, else `OrderPlaced`. */
    readonly purchaseStage: string;
    readonly events: readonly {
      readonly name: string;
      readonly enabled: boolean;
      readonly client: boolean;
    }[];
  };
}

export interface TrackingApi {
  /** In the order's transaction: what the website knew of the shopper (D-963). */
  recordOrderSignals(
    tx: Tx,
    orgId: string,
    orderId: string,
    signals: OrderSignals,
    options: { readonly awaitingPayment: boolean },
  ): Promise<void>;
  /** In the payment's transaction: a Purchase waiting on it may go now. */
  paymentBooked(tx: Tx, orgId: string, orderId: string): Promise<void>;
  ingestBrowserEvents(orgId: string, input: BrowserEventsInput): Promise<BrowserEventsResult>;
  clientConfig(orgId: string): Promise<TrackingClientConfig>;
}

// --- the one-time import (D-961) ---------------------------------------------------------------

/** A platform's settings as an old screen kept them. The secret is plaintext, in memory only. */
export interface LegacyDestination {
  readonly enabled: boolean;
  readonly clientEnabled: boolean;
  readonly publicIds: Readonly<Record<string, string>>;
  readonly secret: string | null;
  readonly testCode: string;
  readonly apiVersion: string;
}

export interface LegacyTrackingSnapshot {
  readonly source: 'storefront' | 'marketing';
  readonly settings?: {
    readonly webRoutes: readonly unknown[];
    readonly proxy: Readonly<Record<string, string>>;
    readonly testMode: boolean;
    readonly defaultCountryCode: string;
    readonly logRetentionDays: number;
  };
  readonly sendNameAndCity?: boolean;
  readonly meta?: LegacyDestination;
  readonly ga4?: LegacyDestination;
}

export interface LegacyTrackingSource {
  readonly name: 'storefront' | 'marketing';
  /** The brand's old settings, or null when it never set any. */
  read(tx: Tx, orgId: string): Promise<LegacyTrackingSnapshot | null>;
}

/**
 * Storefront and marketing register their old settings here at init (the delivery observer's
 * pattern, D-262), so the hub imports them without reading another module's tables.
 */
@Injectable()
export class TrackingLegacySources {
  private readonly sources: LegacyTrackingSource[] = [];

  register(source: LegacyTrackingSource): void {
    if (!this.sources.some((known) => known.name === source.name)) this.sources.push(source);
  }

  /** Storefront first: its settings were the ones the owner filled in. */
  all(): readonly LegacyTrackingSource[] {
    const order = ['storefront', 'marketing'];
    return [...this.sources].sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  }
}
