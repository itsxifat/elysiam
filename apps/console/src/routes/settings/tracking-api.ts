import type {
  TrackingDestinationInput,
  TrackingHubSettingsInput,
  TrackingLogPage,
  TrackingLogQuery,
  TrackingSetupView,
  TrackingSummary,
  TrackingTestResult,
} from '@elysium/contracts';

import { api } from '../../api.js';

/**
 * Settings → Tracking (M54, D-957 to D-969), typed to the contract's answers. Secrets go one
 * way: a save may carry a token, an answer carries only its fingerprint.
 */

export function getTrackingSetup(): Promise<TrackingSetupView> {
  return api.get('/v1/tracking');
}

export function saveTrackingSettings(input: TrackingHubSettingsInput): Promise<TrackingSetupView> {
  return api.put('/v1/tracking/settings', input);
}

export function saveTrackingDestination(
  input: TrackingDestinationInput,
): Promise<TrackingSetupView> {
  return api.put(`/v1/tracking/destinations/${input.kind}`, input);
}

export function testTrackingDestination(kind: 'meta' | 'ga4'): Promise<TrackingTestResult> {
  return api.post(`/v1/tracking/destinations/${kind}/test`, {});
}

export function listTrackingLog(
  query: Partial<Omit<TrackingLogQuery, 'limit'>>,
): Promise<TrackingLogPage> {
  const params = new URLSearchParams({ limit: '50' });
  for (const [key, value] of Object.entries(query)) {
    if (typeof value === 'string' && value !== '') params.set(key, value);
  }
  return api.get(`/v1/tracking/events?${params.toString()}`);
}

export function getTrackingSummary(): Promise<TrackingSummary> {
  return api.get('/v1/tracking/summary');
}

export function getOrderTracking(orderId: string): Promise<TrackingLogPage> {
  return api.get(`/v1/tracking/orders/${orderId}`);
}

export function retryTrackingDelivery(id: string): Promise<{ readonly ok: true }> {
  return api.post(`/v1/tracking/deliveries/${id}/retry`, {});
}
