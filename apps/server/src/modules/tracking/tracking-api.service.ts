import { Injectable } from '@nestjs/common';
import type { Tx } from '@elysium/db';
import type { OrderSignals } from '@elysium/domain/tracking';

import { TrackingOrderEvents } from './order-events.service.js';
import { TrackingSetupService } from './setup.service.js';
import type {
  BrowserEventsInput,
  BrowserEventsResult,
  TrackingApi,
  TrackingClientConfig,
} from './tracking.api.js';

/** `TRACKING_API` (D-959): what storefront asks of the hub. */
@Injectable()
export class TrackingApiService implements TrackingApi {
  constructor(
    private readonly events: TrackingOrderEvents,
    private readonly setup: TrackingSetupService,
  ) {}

  recordOrderSignals(
    tx: Tx,
    orgId: string,
    orderId: string,
    signals: OrderSignals,
    options: { readonly awaitingPayment: boolean },
  ): Promise<void> {
    return this.events.recordOrderSignals(tx, orgId, orderId, signals, options);
  }

  paymentBooked(tx: Tx, orgId: string, orderId: string): Promise<void> {
    return this.events.paymentBooked(tx, orgId, orderId);
  }

  ingestBrowserEvents(orgId: string, input: BrowserEventsInput): Promise<BrowserEventsResult> {
    return this.events.ingestBrowserEvents(orgId, input);
  }

  clientConfig(orgId: string): Promise<TrackingClientConfig> {
    return this.setup.clientConfig(orgId);
  }
}
