import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { withGlobal, withOrg, type Tx } from '@elysium/db';
import { addDays, businessDate, type IsoDate } from '@elysium/domain';
import {
  aggregateMetaSpend,
  MetaSpendError,
  spendPerCampaign,
  type MetaInsightRow,
} from '@elysium/domain/marketing';
import { sql } from 'drizzle-orm';

import { AuditService } from '../../platform/audit/audit.service.js';
import { enqueue } from '../../platform/jobs/enqueue.js';
import { TrackingLegacySources, type LegacyTrackingSnapshot } from '../tracking/tracking.api.js';
import { openToken } from './credentials.js';
import { MARKETING_CONFIG, type MarketingConfig } from './marketing.config.js';
import { MarketingError } from './marketing.errors.js';
import { MARKETING_QUEUES } from './marketing.queues.js';
import * as repo from './marketing.repository.js';
import { META_GATEWAY, MetaApiError, type MetaGateway } from './providers/meta-gateway.js';

/** Who the jobs act as in the audit log and on the rows they write. */
const ACTOR = 'system:marketing';

/** How many days back the scheduled import re-reads: Meta revises recent spend (D-254). */
const IMPORT_DAYS = 3;

export interface ImportResult {
  readonly status: 'ok' | 'failed';
  readonly days: number;
  readonly written: number;
  readonly keptManual: number;
  /** Imported figures in the range that Meta's answer no longer supports, set to zero. */
  readonly zeroed: number;
  readonly campaignsCreated: number;
  readonly error: string | null;
}

const EMPTY_IMPORT = {
  days: 0,
  written: 0,
  keptManual: 0,
  zeroed: 0,
  campaignsCreated: 0,
} as const;

export type ConversionOutcome = 'sent' | 'failed' | 'skipped' | 'already_final';

/**
 * The Meta jobs and the delivery hook (architecture §11, §20; M18).
 *
 * The rule that shapes every method: **no Meta call inside a transaction** (invariant 6).
 * The import reads the link, closes the transaction, fetches, then opens a new one to
 * write. The conversion sender stages the hashed payload in one transaction, sends with
 * none open, and records Meta's answer in a third.
 */
@Injectable()
export class MetaJobsService implements OnModuleInit {
  private readonly logger = new Logger('marketing');

  constructor(
    private readonly audit: AuditService,
    private readonly legacy: TrackingLegacySources,
    @Inject(MARKETING_CONFIG) private readonly config: MarketingConfig,
    @Inject(META_GATEWAY) private readonly gateway: MetaGateway,
  ) {}

  /**
   * M54 (D-957, D-961): conversions are the tracking hub's now, at the brand's Purchase stage,
   * for every channel. This module no longer hears deliveries; it hands its Meta link's pixel,
   * token, test code and consent to the hub once, for a brand that has no tracking settings.
   */
  onModuleInit(): void {
    this.legacy.register({ name: 'marketing', read: (tx, orgId) => this.snapshot(tx, orgId) });
  }

  private async snapshot(tx: Tx, orgId: string): Promise<LegacyTrackingSnapshot | null> {
    const link = await repo.connection(tx, orgId);
    if (link === undefined) return null;
    let secret: string | null = null;
    if (link.token !== null && this.config.MARKETING_CREDENTIALS_KEY !== undefined) {
      try {
        secret = openToken(Buffer.from(link.token), orgId, this.tokenKey());
      } catch {
        // A token this server cannot open stays behind; the org admin enters it again.
        secret = null;
      }
    }
    return {
      source: 'marketing',
      sendNameAndCity: link.send_name_and_city,
      ...(link.pixel_id === null
        ? {}
        : {
            meta: {
              enabled: link.capi_enabled,
              clientEnabled: false,
              publicIds: { pixelId: link.pixel_id, datasetId: '' },
              secret,
              testCode: link.test_event_code ?? '',
              apiVersion: '',
            },
          }),
    };
  }

  private tokenKey() {
    return {
      key: this.config.MARKETING_CREDENTIALS_KEY,
      keyId: this.config.MARKETING_CREDENTIALS_KEY_ID,
    };
  }

  // --- the conversion sender -------------------------------------------------------

  /**
   * A delivered order's Purchase queued before M54 (D-957): never sent. The tracking hub sends
   * every order's Purchase at the brand's stage, for every channel; a second one at delivery
   * would count the sale twice. The row is closed as `skipped` with the reason; a row already
   * final is left alone.
   */
  async sendConversion(orgId: string, eventId: string): Promise<ConversionOutcome> {
    return withOrg({ orgId, userId: ACTOR }, async (tx) => {
      const row = await repo.capiEventById(tx, orgId, eventId);
      if (row === undefined || row.status === 'sent' || row.status === 'skipped') {
        return 'already_final';
      }
      await repo.finishCapiEvent(tx, orgId, eventId, {
        status: 'skipped',
        response: null,
        error: 'Conversions moved to Settings → Tracking (D-957).',
        sentAt: null,
      });
      return 'skipped';
    });
  }

  // --- the spend import ------------------------------------------------------------

  /**
   * Import a date range of Meta spend for one brand. Idempotent per (campaign, day): a
   * rerun, or an overlapping range, replaces each imported figure rather than adding to
   * it, and a figure a person entered is kept (M18 check 2, D-252).
   *
   * A Meta campaign the brand has not mapped yet becomes a campaign of its own, named as
   * Meta names it (D-254), and every ad id seen is mapped to its campaign so that a
   * click-to-message referral attributes without anybody typing ad ids.
   *
   * A Meta campaign's spend for a day lands on exactly one campaign: Meta campaigns mapped
   * to the same campaign are added, an imported figure in the range that Meta's answer no
   * longer supports is zeroed, and the import refuses to run while spend typed by hand for
   * an unmapped Meta campaign sits in the range (D-252, D-254).
   */
  async importSpend(
    orgId: string,
    range: { readonly from: string; readonly to: string },
    now: Date = new Date(),
  ): Promise<ImportResult> {
    const actor = { orgId, userId: ACTOR };
    const failed = async (error: string): Promise<ImportResult> => {
      await withOrg(actor, (tx) =>
        repo.recordImport(tx, orgId, { status: 'failed', error, at: now }),
      );
      return { ...EMPTY_IMPORT, status: 'failed', error };
    };

    const link = await withOrg(actor, (tx) => repo.connection(tx, orgId));
    if (link?.ad_account_id == null || link.token === null) {
      return failed('The brand has no Meta ad account or token.');
    }
    let token: string;
    try {
      token = openToken(Buffer.from(link.token as Uint8Array), orgId, this.tokenKey());
    } catch (cause) {
      if (cause instanceof MarketingError) return failed(cause.message);
      throw cause;
    }

    let rows: MetaInsightRow[];
    let aggregated: ReturnType<typeof aggregateMetaSpend>;
    try {
      rows = await this.gateway.fetchInsights({
        adAccountId: link.ad_account_id,
        token,
        since: range.from,
        until: range.to,
      });
      aggregated = aggregateMetaSpend(rows);
    } catch (cause) {
      if (cause instanceof MetaSpendError) return failed(cause.message);
      if (cause instanceof MetaApiError) {
        const result = await failed(cause.message);
        // A timeout or a 5xx is worth another go; a refusal Meta named is not.
        if (cause.retryable) throw cause;
        return result;
      }
      throw cause;
    }

    return withOrg(actor, async (tx) => {
      // The connection row's lock makes a brand's imports take turns (two workers could
      // otherwise both create a campaign for one new Meta campaign), and re-reading it
      // keeps the fetched figures from landing after the brand changed its ad account.
      const current = await repo.connection(tx, orgId, true);
      if (current?.ad_account_id !== link.ad_account_id || current.token === null) {
        const error = 'The ad account or token changed during the import; nothing was written.';
        await repo.recordImport(tx, orgId, { status: 'failed', error, at: now });
        return { ...EMPTY_IMPORT, status: 'failed', error };
      }
      // Spend typed by hand for a Meta campaign nobody mapped is spend the import is about
      // to write again under a campaign of its own. Refuse, and say what to map (D-254).
      const unmapped = await repo.unmappedManualMetaSpend(tx, orgId, range);
      if (unmapped.length > 0) {
        const error =
          `Spend was entered by hand for ${unmapped.slice(0, 5).join(', ')}` +
          `${unmapped.length > 5 ? ` and ${String(unmapped.length - 5)} more` : ''}, ` +
          'not mapped to a Meta campaign id. Map each to its Meta campaign, or set its ' +
          'platform to another if its ads are not in this ad account, then import again.';
        await repo.recordImport(tx, orgId, { status: 'failed', error, at: now });
        return { ...EMPTY_IMPORT, status: 'failed', error };
      }

      const byMetaId = new Map(
        (await repo.listRefs(tx, orgId))
          .filter((ref) => ref.kind === 'meta_campaign')
          .map((ref) => [ref.value, ref.campaign_id]),
      );
      let campaignsCreated = 0;
      for (const day of aggregated.days) {
        if (byMetaId.has(day.metaCampaignId)) continue;
        const name = day.campaignName.trim();
        const id = await repo.insertCampaign(tx, {
          orgId,
          name: (name === '' ? `Meta ${day.metaCampaignId}` : name).slice(0, 200),
          platform: 'meta',
          productIds: [],
          startsOn: null,
          endsOn: null,
          origin: 'meta_import',
          createdBy: ACTOR,
        });
        const ref = await repo.insertRef(tx, {
          orgId,
          campaignId: id,
          kind: 'meta_campaign',
          value: day.metaCampaignId,
          createdBy: ACTOR,
        });
        // Somebody mapped this id by hand while the import ran. Roll back and let the
        // job's retry write the spend where they mapped it.
        if (ref === undefined) {
          throw new Error('a Meta campaign was mapped while the spend import ran; retrying');
        }
        byMetaId.set(day.metaCampaignId, id);
        campaignsCreated += 1;
      }

      // One figure per campaign of ours: several Meta campaigns mapped to one are added.
      const figures = spendPerCampaign(rows, (metaCampaignId) => {
        const campaignId = byMetaId.get(metaCampaignId);
        if (campaignId === undefined) throw new Error('a Meta campaign has no campaign');
        return campaignId;
      });
      let written = 0;
      let keptManual = 0;
      for (const figure of figures) {
        const outcome = await repo.upsertImportedSpend(tx, {
          orgId,
          campaignId: figure.campaignId,
          spendDate: figure.spendOn,
          amountPoisha: BigInt(figure.amountPoisha),
          enteredBy: ACTOR,
        });
        if (outcome === 'written') written += 1;
        else keptManual += 1;
      }
      // Meta's answer covers the whole range, so an imported figure it no longer supports
      // goes to zero — after a Meta campaign id moves to another campaign, its spend is
      // written there and taken off the old one, never counted on both.
      const zeroed = await repo.zeroStaleImports(tx, {
        orgId,
        from: range.from,
        to: range.to,
        written: figures.map((figure) => ({
          campaignId: figure.campaignId,
          spendDate: figure.spendOn,
        })),
        enteredBy: ACTOR,
      });

      for (const [metaCampaignId, ads] of aggregated.adsByCampaign) {
        const campaignId = byMetaId.get(metaCampaignId);
        if (campaignId === undefined) continue;
        // An ad already mapped (to this campaign, or by hand to another) is left as it is.
        for (const ad of ads) {
          await repo.insertRef(tx, {
            orgId,
            campaignId,
            kind: 'meta_ad',
            value: ad,
            createdBy: ACTOR,
          });
        }
      }

      await repo.recordImport(tx, orgId, { status: 'ok', error: null, at: now });
      await this.audit.record(tx, {
        orgId,
        actorUserId: null,
        operation: 'update',
        action: 'marketing.spend.imported',
        entityType: 'CampaignSpend',
        entityId: link.id,
        before: null,
        after: { from: range.from, to: range.to, written, keptManual, zeroed, campaignsCreated },
      });
      return {
        status: 'ok',
        days: figures.length,
        written,
        keptManual,
        zeroed,
        campaignsCreated,
        error: null,
      };
    });
  }

  /**
   * The scheduled half: one import of the last three Dhaka days per brand that turned the
   * daily import on. Returns how many brands were queued.
   */
  async fanOutImports(now: Date = new Date()): Promise<number> {
    const today: IsoDate = businessDate(now);
    const from = addDays(today, -IMPORT_DAYS);
    const to = addDays(today, -1);
    const orgIds = await withGlobal(async (tx) => {
      const rows = await tx.execute<{ id: string }>(sql`
        select id from org.organizations where is_active order by slug
      `);
      return [...rows].map((row) => row.id);
    });
    let queued = 0;
    for (const orgId of orgIds) {
      const wanted = await withOrg({ orgId, userId: ACTOR }, async (tx) => {
        const link = await repo.connection(tx, orgId);
        if (
          link?.spend_import_enabled !== true ||
          link.ad_account_id === null ||
          link.token === null
        ) {
          return false;
        }
        await enqueue(
          tx,
          MARKETING_QUEUES.importSpend,
          { from, to },
          { orgId, singletonKey: `spend:${orgId}:${from}:${to}` },
        );
        return true;
      });
      if (wanted) queued += 1;
    }
    this.logger.log(`spend import queued for ${String(queued)} brand(s), ${from} to ${to}`);
    return queued;
  }
}
