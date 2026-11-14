import { HttpStatus, Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { TrackingEventsRequest } from '@elysium/contracts';
import { withGlobal, withOrg, type Tx } from '@elysium/db';
import { sql } from 'drizzle-orm';

import type { RateLimitStore } from '../../platform/http/rate-limit.js';
import { open, sealedBoxConfigured } from '../../platform/crypto/sealed-box.js';
import {
  TRACKING_API,
  TrackingLegacySources,
  type BrowserEventsResult,
  type LegacyTrackingSnapshot,
  type TrackingApi,
  type TrackingClientConfig,
} from '../tracking/tracking.api.js';
import { StorefrontError } from './storefront.errors.js';
import { STOREFRONT_RATE_LIMITER } from './signature.guard.js';
import * as repo from './web-marketing.repository.js';

/** Browser events one shopper may forward a minute (the old site's 120). */
const EVENTS_PER_MINUTE = 120;

/**
 * The website's tracking, now the tracking hub's (M54, D-959): the signed storefront routes the
 * website calls (its browser config and the events it forwards, rate-limited per shopper here,
 * as M35b did) hand over to `TRACKING_API`. Settings → Tracking replaced Website → Tracking.
 *
 * What is left of M35b's own tracking is its old settings, handed to the hub once (D-961), and
 * the nightly purge of its old event log until that log is empty.
 */
@Injectable()
export class TrackingService implements OnModuleInit {
  constructor(
    @Inject(TRACKING_API) private readonly hub: TrackingApi,
    @Inject(STOREFRONT_RATE_LIMITER) private readonly limiter: RateLimitStore,
    private readonly legacy: TrackingLegacySources,
  ) {}

  onModuleInit(): void {
    this.legacy.register({ name: 'storefront', read: (tx, orgId) => this.snapshot(tx, orgId) });
  }

  /** What the browser's helper needs: the pixel, the measurement id, the paths. No secret. */
  clientConfig(orgId: string): Promise<TrackingClientConfig> {
    return this.hub.clientConfig(orgId);
  }

  /** Browser events the website forwards (the old `/api/events`), at most 120 a minute each. */
  async ingest(orgId: string, input: TrackingEventsRequest): Promise<BrowserEventsResult> {
    if (input.client !== undefined) {
      const decision = await this.limiter.hit(
        `storefront:events:${orgId}:${input.client.ip}`,
        EVENTS_PER_MINUTE,
        60,
      );
      if (!decision.allowed) {
        throw new StorefrontError(
          'RATE_LIMITED',
          HttpStatus.TOO_MANY_REQUESTS,
          'Too many events from this shopper. Wait a minute.',
          decision.retryAfterSeconds ?? 60,
        );
      }
    }
    return this.hub.ingestBrowserEvents(orgId, input);
  }

  /**
   * Website → Tracking's settings as M35b kept them (D-961), its secrets opened under their old
   * binding, in memory only, for the hub to seal under its own. The Graph API version is left
   * to the hub's default: M35b's `v21.0` was a default nobody chose.
   */
  private async snapshot(tx: Tx, orgId: string): Promise<LegacyTrackingSnapshot | null> {
    const row = await repo.trackingSettings(tx, orgId);
    if (row === undefined) return null;
    const bind = (field: string) => ({ orgId, row: 'tracking_settings', field });
    const secret = (sealed: Buffer | null, field: string): string | null => {
      if (sealed === null || !sealedBoxConfigured()) return null;
      try {
        return open(Buffer.from(sealed as unknown as Uint8Array), bind(field));
      } catch {
        // Sealed under another key: this secret stays behind, the rest moves (the audit's W5).
        return null;
      }
    };
    const proxy =
      row.proxy !== null && typeof row.proxy === 'object'
        ? Object.fromEntries(
            Object.entries(row.proxy as Record<string, unknown>).filter(
              (entry): entry is [string, string] => typeof entry[1] === 'string',
            ),
          )
        : {};
    return {
      source: 'storefront',
      settings: {
        webRoutes: Array.isArray(row.events) ? (row.events as unknown[]) : [],
        proxy,
        testMode: row.test_mode,
        defaultCountryCode: row.default_country_code,
        logRetentionDays: row.log_retention_days,
      },
      meta: {
        enabled: row.meta_capi_enabled,
        clientEnabled: row.meta_pixel_enabled,
        publicIds: { pixelId: row.meta_pixel_id, datasetId: row.meta_dataset_id },
        secret: secret(row.meta_token_sealed, 'meta_token'),
        testCode: row.meta_test_event_code,
        apiVersion: '',
      },
      ga4: {
        enabled: row.ga4_mp_enabled,
        clientEnabled: row.ga4_client_enabled,
        publicIds: { measurementId: row.ga4_measurement_id },
        secret: secret(row.ga4_secret_sealed, 'ga4_secret'),
        testCode: '',
        apiVersion: '',
      },
    };
  }

  /** The nightly purge of M35b's old event log, past each brand's retention (D-552). */
  async purgeAll(): Promise<number> {
    const orgIds = await withGlobal(async (tx) => {
      const rows = await tx.execute<{ id: string }>(
        sql`select id from org.organizations order by slug`,
      );
      return [...rows].map((row) => row.id);
    });
    let removed = 0;
    for (const orgId of orgIds) {
      removed += await withOrg({ orgId }, (tx) => repo.purgeTrackingEvents(tx, orgId));
    }
    return removed;
  }
}
