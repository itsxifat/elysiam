import { Module, type Provider } from '@nestjs/common';

import { AuditService } from '../../platform/audit/audit.service.js';
import { OrdersModule } from '../orders/orders.module.js';
import { TrackingDeliveries } from './delivery.service.js';
import { TrackingLog } from './log.service.js';
import { TrackingOrderEvents } from './order-events.service.js';
import { TRACKING_GATEWAY } from './providers/gateway.js';
import { TrackingSetupService } from './setup.service.js';
import { TRACKING_API, TrackingLegacySources } from './tracking.api.js';
import { TrackingApiService } from './tracking-api.service.js';
import {
  TRACKING_CONFIG,
  trackingConfig,
  trackingGatewayFor,
  type TrackingConfig,
} from './tracking.config.js';
import { TrackingController } from './tracking.controller.js';

/**
 * The tracking hub (M54, D-957 to D-973): Settings → Tracking, every order's stage events to
 * the ad and analytics platforms whatever the channel, the website's signals and browser events,
 * one delivery per platform, the log, and the one-time import of the old screens' settings.
 *
 * Orders through `ORDERS_API` and the outbox (invariant 12). Storefront imports this module for
 * `TRACKING_API` and registers its old settings with `TrackingLegacySources`, as marketing does;
 * this module imports neither. The config and the gateway are factories run at `app.init()`, so
 * a half-set configuration stops the process at boot.
 */
const configProvider: Provider = {
  provide: TRACKING_CONFIG,
  useFactory: () => trackingConfig(),
};

const gatewayProvider: Provider = {
  provide: TRACKING_GATEWAY,
  useFactory: (config: TrackingConfig) => trackingGatewayFor(config),
  inject: [TRACKING_CONFIG],
};

@Module({
  imports: [OrdersModule],
  controllers: [TrackingController],
  providers: [
    configProvider,
    gatewayProvider,
    AuditService,
    TrackingLegacySources,
    TrackingSetupService,
    TrackingOrderEvents,
    TrackingDeliveries,
    TrackingLog,
    TrackingApiService,
    { provide: TRACKING_API, useExisting: TrackingApiService },
  ],
  exports: [
    TRACKING_API,
    TrackingLegacySources,
    TrackingOrderEvents,
    TrackingDeliveries,
    TrackingSetupService,
    TRACKING_GATEWAY,
  ],
})
export class TrackingModule {}
