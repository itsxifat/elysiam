import { describe, expect, it } from 'vitest';

import { FakeTrackingGateway, LiveTrackingGateway } from './providers/gateway.js';
import { trackingConfig, trackingGatewayFor } from './tracking.config.js';

/** D-968: `fake` unless both switches say otherwise, and M35b's names still read. */
describe('the tracking hub’s configuration', () => {
  it('is fake by default, and an empty value is absent', () => {
    const config = trackingConfig({ TRACKING_PROVIDER: '', TRACKING_ENABLED: '' });
    expect(config.TRACKING_PROVIDER).toBe('fake');
    expect(trackingGatewayFor(config)).toBeInstanceOf(FakeTrackingGateway);
  });

  it('stops the process when live is named without being enabled', () => {
    expect(() => trackingConfig({ TRACKING_PROVIDER: 'live' })).toThrow(/TRACKING_ENABLED=true/);
    const live = trackingConfig({ TRACKING_PROVIDER: 'live', TRACKING_ENABLED: 'true' });
    expect(trackingGatewayFor(live)).toBeInstanceOf(LiveTrackingGateway);
  });

  it('reads M35b’s names when the new ones are absent, and prefers the new ones', () => {
    expect(() => trackingConfig({ STOREFRONT_TRACKING_PROVIDER: 'live' })).toThrow();
    expect(
      trackingConfig({ STOREFRONT_TRACKING_PROVIDER: 'live', STOREFRONT_TRACKING_ENABLED: 'true' })
        .TRACKING_PROVIDER,
    ).toBe('live');
    expect(
      trackingConfig({ STOREFRONT_TRACKING_PROVIDER: 'live', TRACKING_PROVIDER: 'fake' })
        .TRACKING_PROVIDER,
    ).toBe('fake');
  });
});
