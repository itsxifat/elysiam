import { createHash, randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { defineAbilityFor } from '@elysium/contracts';
import {
  TRACKING_DESTINATION_KINDS,
  type TrackingDestinationInput,
  type TrackingDestinationKind,
  type TrackingHubSettingsInput,
  type TrackingSetupView,
  type TrackingTestResult,
} from '@elysium/contracts/tracking';
import { withGlobal, withOrg, type Tx } from '@elysium/db';
import { ga4Payload, metaEvent, retentionDays } from '@elysium/domain/storefront';
import { cleanStageRoutes } from '@elysium/domain/tracking';
import { sql } from 'drizzle-orm';
import type { Logger } from 'pino';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { open, seal, sealedBoxConfigured } from '../../platform/crypto/sealed-box.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { createLogger } from '../../platform/logging/logger.js';
import { TRACKING_GATEWAY, type TrackingGateway } from './providers/gateway.js';
import {
  TrackingLegacySources,
  type LegacyDestination,
  type LegacyTrackingSnapshot,
  type TrackingClientConfig,
} from './tracking.api.js';
import { TrackingError } from './tracking.errors.js';
import * as repo from './tracking.repository.js';
import {
  AVAILABLE_DESTINATIONS,
  bindings,
  DEFAULT_META_API_VERSION,
  defaultWebRoutes,
  destinationReady,
  destinationView,
  hubSettings,
  metaTarget,
  publicIdsOf,
  settingsValues,
  settingsView,
  webRoutesOf,
  type HubSettings,
} from './tracking-state.js';

const IMPORTER = 'system:tracking-import';

/**
 * Settings → Tracking (M54, D-957 to D-969): the brand's settings and destinations, the test
 * send, the one-time import of the old screens' settings (D-961) and the website's config.
 *
 * Marketing runs the switches, the Purchase stage, the routes, test mode and retention
 * (`update Tracking`); where buyers' hashed details go (a destination's ids and secret) is the
 * org admin's (`update TrackingCredentials`, D-969, D-558's rule). Secrets are sealed, write-only
 * and shown as a fingerprint. Every save writes its audit row in its own transaction.
 */
@Injectable()
export class TrackingSetupService {
  private cachedLogger: Logger | undefined;

  private get logger(): Logger {
    this.cachedLogger ??= createLogger('tracking');
    return this.cachedLogger;
  }

  constructor(
    @Inject(TRACKING_GATEWAY) private readonly gateway: TrackingGateway,
    private readonly legacy: TrackingLegacySources,
    private readonly audit: AuditService,
  ) {}

  // --- the console ----------------------------------------------------------------------------

  async setup(context: ActiveContext): Promise<TrackingSetupView> {
    await this.importIfNeeded(context.orgId);
    return withOrg(context, (tx) => this.view(tx, context.orgId));
  }

  async saveSettings(
    context: ActiveContext,
    request: AuditableRequest | undefined,
    input: TrackingHubSettingsInput,
  ): Promise<TrackingSetupView> {
    await this.importIfNeeded(context.orgId);
    return withOrg(context, async (tx) => {
      const before = await repo.settings(tx, context.orgId);
      const next: HubSettings = {
        ...hubSettings(before),
        purchaseStage: input.purchaseStage,
        stageRoutes: cleanStageRoutes(input.stageRoutes),
        webRoutes: webRoutesOf(input.webRoutes),
        proxy: input.proxy,
        testMode: input.testMode,
        sendNameAndCity: input.sendNameAndCity,
        chatToGa4: input.chatToGa4,
        defaultCountryCode: input.defaultCountryCode,
        logRetentionDays: retentionDays(input.logRetentionDays),
      };
      if (before === undefined) {
        await repo.insertSettings(tx, context.orgId, settingsValues(next), 'none', context.userId);
      } else {
        await repo.updateSettings(tx, context.orgId, settingsValues(next), context.userId);
      }
      const facts = (settings: HubSettings) => ({
        purchaseStage: settings.purchaseStage,
        stageRoutes: settings.stageRoutes,
        testMode: settings.testMode,
        sendNameAndCity: settings.sendNameAndCity,
        chatToGa4: settings.chatToGa4,
        logRetentionDays: settings.logRetentionDays,
        webRoutes: settings.webRoutes.length,
      });
      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: before === undefined ? 'create' : 'update',
        action: 'tracking.settings_updated',
        entityType: 'tracking.settings',
        entityId: context.orgId,
        before: before === undefined ? null : facts(hubSettings(before)),
        after: facts(next),
        requestId: context.requestId,
        ...(request === undefined ? {} : { request }),
      });
      return this.view(tx, context.orgId);
    });
  }

  async saveDestination(
    context: ActiveContext,
    request: AuditableRequest | undefined,
    input: TrackingDestinationInput,
  ): Promise<TrackingSetupView> {
    if (!AVAILABLE_DESTINATIONS.includes(input.kind)) {
      throw new TrackingError(
        'TRACKING_DESTINATION_UNAVAILABLE',
        'That platform cannot be set up yet.',
      );
    }
    const newSecret = input.kind === 'meta' ? input.accessToken : input.apiSecret;
    if (typeof newSecret === 'string' && !sealedBoxConfigured()) {
      throw new TrackingError(
        'TRACKING_CREDENTIALS_MISSING',
        'This server has no STOREFRONT_CREDENTIALS_KEY, so the token or secret cannot be kept.',
      );
    }
    await this.importIfNeeded(context.orgId);
    return withOrg(context, async (tx) => {
      const before = await repo.destination(tx, context.orgId, input.kind);
      const ids: Record<string, string> =
        input.kind === 'meta'
          ? { pixelId: input.pixelId, datasetId: input.datasetId }
          : { measurementId: input.measurementId };
      const beforeIds = publicIdsOf(before);
      const idsChanged = Object.entries(ids).some(
        ([key, value]) => (beforeIds[key] ?? '') !== value,
      );
      // Where buyers' hashed details go is the org admin's (D-969).
      if (
        (idsChanged || newSecret !== undefined) &&
        !defineAbilityFor(context).can('update', 'TrackingCredentials')
      ) {
        throw new TrackingError(
          'TRACKING_CREDENTIALS_FORBIDDEN',
          'Only an org admin changes a platform’s ids or its secret.',
        );
      }
      const sealed =
        typeof newSecret === 'string'
          ? seal(newSecret, bindings.secret(context.orgId, input.kind))
          : newSecret;
      await repo.upsertDestination(
        tx,
        context.orgId,
        {
          kind: input.kind,
          enabled: input.enabled,
          clientEnabled: input.clientEnabled,
          publicIds: ids,
          secret:
            sealed === undefined || sealed === null
              ? sealed
              : { sealed: sealed.ciphertext, fingerprint: sealed.fingerprint, keyId: sealed.keyId },
          testCode: input.kind === 'meta' ? input.testCode : '',
          apiVersion: input.kind === 'meta' ? input.apiVersion : '',
          options: {},
        },
        context.userId,
      );
      const after = await repo.destination(tx, context.orgId, input.kind);
      // Ids and fingerprints only: no secret is ever passed to the audit.
      const facts = (row: repo.DestinationRow | undefined) => ({
        enabled: row?.enabled ?? false,
        clientEnabled: row?.client_enabled ?? false,
        ids: publicIdsOf(row),
        secretFingerprint: row?.secret_fingerprint ?? null,
        testCode: row?.test_code ?? '',
      });
      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: before === undefined ? 'create' : 'update',
        action: 'tracking.destination_updated',
        entityType: 'tracking.destinations',
        entityId: after?.id ?? input.kind,
        before: before === undefined ? null : facts(before),
        after: facts(after),
        requestId: context.requestId,
        ...(request === undefined ? {} : { request }),
      });
      return this.view(tx, context.orgId);
    });
  }

  /**
   * Send one test event to a destination, now, with no transaction open while the platform is
   * called (invariant 6). Meta gets a custom `ErpConnectionTest` under the destination's test
   * code when it has one; GA4's validation endpoint answers without recording anything.
   */
  async test(
    context: ActiveContext,
    request: AuditableRequest | undefined,
    kind: TrackingDestinationKind,
  ): Promise<TrackingTestResult> {
    if (!AVAILABLE_DESTINATIONS.includes(kind)) {
      throw new TrackingError(
        'TRACKING_DESTINATION_UNAVAILABLE',
        'That platform cannot be set up yet.',
      );
    }
    const row = await withOrg(context, (tx) => repo.destination(tx, context.orgId, kind));
    if (row === undefined || !destinationReady(row) || row.secret_sealed === null) {
      throw new TrackingError(
        'TRACKING_NOT_READY',
        'Add the platform’s ids and its token or secret first.',
      );
    }
    const secret = open(row.secret_sealed, bindings.secret(context.orgId, kind));
    const ids = publicIdsOf(row);
    const now = Math.floor(Date.now() / 1000);
    const eventId = `test_${randomUUID()}`;
    const result =
      kind === 'meta'
        ? await this.gateway.sendMeta({
            apiVersion: row.api_version === '' ? DEFAULT_META_API_VERSION : row.api_version,
            target: metaTarget(ids),
            token: secret,
            event: metaEvent({
              eventName: 'ErpConnectionTest',
              eventId,
              eventTime: now,
              actionSource: 'system_generated',
              userData: { external_id: createHash('sha256').update(context.orgId).digest('hex') },
              customData: {},
            }),
            testEventCode: row.test_code === '' ? null : row.test_code,
          })
        : await this.gateway.sendGa4({
            measurementId: ids.measurementId ?? '',
            apiSecret: secret,
            payload: ga4Payload({
              eventName: 'ErpConnectionTest',
              eventId,
              clientId: `${String(now)}.1`,
              customData: {},
              eventTime: now,
            }),
            userAgent: null,
            debug: true,
          });
    const outcome = {
      ok: result.status === 'success',
      error: result.status === 'success' ? null : result.error,
    };
    await withOrg(context, async (tx) => {
      await repo.recordDestinationTest(tx, context.orgId, kind, outcome);
      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'update',
        action: 'tracking.destination_tested',
        entityType: 'tracking.destinations',
        entityId: row.id,
        before: null,
        after: { kind, ok: outcome.ok, httpStatus: result.httpStatus },
        requestId: context.requestId,
        ...(request === undefined ? {} : { request }),
      });
    });
    return { ...outcome, detail: { httpStatus: result.httpStatus, ...result.detail } };
  }

  private async view(tx: Tx, orgId: string): Promise<TrackingSetupView> {
    const settings = hubSettings(await repo.settings(tx, orgId));
    const rows = await repo.destinations(tx, orgId);
    return {
      settings: settingsView(settings),
      destinations: TRACKING_DESTINATION_KINDS.map((kind) =>
        destinationView(
          kind,
          rows.find((row) => row.kind === kind),
        ),
      ),
      provider: this.gateway.provider,
      credentialsKey: sealedBoxConfigured(),
    };
  }

  // --- the website ----------------------------------------------------------------------------

  /** What the browser's helper needs: the pixel, the measurement id, the paths. No secret. */
  async clientConfig(orgId: string): Promise<TrackingClientConfig> {
    await this.importIfNeeded(orgId);
    return withOrg({ orgId }, async (tx) => {
      const settings = hubSettings(await repo.settings(tx, orgId));
      const rows = await repo.destinations(tx, orgId);
      const meta = rows.find((row) => row.kind === 'meta');
      const ga4 = rows.find((row) => row.kind === 'ga4');
      return {
        tracking: {
          meta: {
            pixelEnabled: meta?.client_enabled ?? false,
            pixelId: publicIdsOf(meta).pixelId ?? '',
          },
          ga4: {
            clientEnabled: ga4?.client_enabled ?? false,
            measurementId: publicIdsOf(ga4).measurementId ?? '',
          },
          proxy: settings.proxy,
          testMode: settings.testMode,
          purchaseStage: settings.purchaseStage,
          events: settings.webRoutes.map((route) => ({
            name: route.name,
            enabled: route.enabled,
            // D-965: the server sends the Purchase at its stage; a browser one at placement
            // would be a second purchase once the two are 48 hours apart.
            client:
              route.client && (route.name !== 'Purchase' || settings.purchaseStage === 'placed'),
          })),
        },
      };
    });
  }

  // --- the one-time import (D-961) ------------------------------------------------------------

  /** Every brand without settings yet: the worker runs this once at boot. */
  async importAll(): Promise<number> {
    const orgIds = await withGlobal(async (tx) => {
      const rows = await tx.execute<{ id: string }>(
        sql`select id from org.organizations order by slug`,
      );
      return [...rows].map((row) => row.id);
    });
    let imported = 0;
    for (const orgId of orgIds) {
      try {
        if (await this.importIfNeeded(orgId)) imported += 1;
      } catch (error) {
        this.logger.error({ err: error, orgId }, 'the old tracking settings were not imported');
      }
    }
    return imported;
  }

  /**
   * A brand with no tracking settings gets the old screens' (D-961): Website → Tracking's, then
   * Marketing → Meta's pixel and token when Website → Tracking had no Meta pixel. Once per brand:
   * the settings row is its mark, written first, so two importers never both import.
   */
  async importIfNeeded(orgId: string): Promise<boolean> {
    const actor = { orgId, userId: IMPORTER };
    const exists = await withOrg(
      actor,
      async (tx) => (await repo.settings(tx, orgId)) !== undefined,
    );
    if (exists) return false;
    return withOrg(actor, async (tx) => {
      const snapshots: LegacyTrackingSnapshot[] = [];
      for (const source of this.legacy.all()) {
        try {
          const snapshot = await source.read(tx, orgId);
          if (snapshot !== null) snapshots.push(snapshot);
        } catch (error) {
          // A secret this server cannot open is left behind, never the rest.
          this.logger.warn(
            { err: error, orgId, source: source.name },
            'old tracking settings unreadable',
          );
        }
      }
      const web = snapshots.find((snapshot) => snapshot.source === 'storefront');
      const marketing = snapshots.find((snapshot) => snapshot.source === 'marketing');
      const meta =
        web?.meta !== undefined && metaTarget(web.meta.publicIds) !== ''
          ? { from: 'storefront', destination: web.meta }
          : marketing?.meta !== undefined && metaTarget(marketing.meta.publicIds) !== ''
            ? { from: 'marketing', destination: marketing.meta }
            : null;
      const ga4 =
        web?.ga4 !== undefined && (web.ga4.publicIds.measurementId ?? '') !== '' ? web.ga4 : null;
      const sources = new Set<string>();
      if (web?.settings !== undefined) sources.add('storefront');
      if (meta !== null) sources.add(meta.from);
      if (ga4 !== null) sources.add('storefront');
      if (marketing !== undefined) sources.add('marketing');
      const importedFrom =
        sources.size === 0
          ? 'none'
          : sources.size === 2
            ? 'storefront_and_marketing'
            : ([...sources][0] ?? 'none');
      const defaults = hubSettings(undefined);
      const settings: HubSettings = {
        ...defaults,
        ...(web?.settings === undefined
          ? {}
          : {
              webRoutes:
                web.settings.webRoutes.length === 0
                  ? defaultWebRoutes()
                  : webRoutesOf(web.settings.webRoutes),
              proxy: { ...defaults.proxy, ...web.settings.proxy },
              testMode: web.settings.testMode,
              defaultCountryCode: web.settings.defaultCountryCode,
              logRetentionDays: retentionDays(web.settings.logRetentionDays),
            }),
        sendNameAndCity: marketing?.sendNameAndCity ?? false,
      };
      const first = await repo.insertSettings(
        tx,
        orgId,
        settingsValues(settings),
        importedFrom,
        IMPORTER,
      );
      if (!first) return false;
      const put = async (kind: 'meta' | 'ga4', legacy: LegacyDestination) => {
        const sealed =
          legacy.secret !== null && sealedBoxConfigured()
            ? seal(legacy.secret, bindings.secret(orgId, kind))
            : null;
        await repo.upsertDestination(
          tx,
          orgId,
          {
            kind,
            enabled: legacy.enabled,
            clientEnabled: legacy.clientEnabled,
            publicIds: legacy.publicIds,
            secret:
              sealed === null
                ? null
                : {
                    sealed: sealed.ciphertext,
                    fingerprint: sealed.fingerprint,
                    keyId: sealed.keyId,
                  },
            testCode: legacy.testCode,
            apiVersion: kind === 'meta' ? legacy.apiVersion || DEFAULT_META_API_VERSION : '',
            options: {},
          },
          IMPORTER,
        );
      };
      // Marketing could set Marketing → Meta's pixel and token; where buyers' details go is the
      // org admin's (D-969), so a pixel from there arrives switched off (the audit's W3).
      if (meta !== null) {
        await put(
          'meta',
          meta.from === 'marketing' ? { ...meta.destination, enabled: false } : meta.destination,
        );
      }
      if (ga4 !== null) await put('ga4', ga4);
      await this.audit.record(tx, {
        orgId,
        actorUserId: IMPORTER,
        operation: 'create',
        action: 'tracking.imported',
        entityType: 'tracking.settings',
        entityId: orgId,
        before: null,
        after: {
          importedFrom,
          meta: meta === null ? null : { from: meta.from, ids: meta.destination.publicIds },
          ga4: ga4 === null ? null : { ids: ga4.publicIds },
        },
      });
      return true;
    });
  }
}
