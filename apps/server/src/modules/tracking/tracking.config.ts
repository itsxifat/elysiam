import { z } from 'zod';

import {
  FakeTrackingGateway,
  LiveTrackingGateway,
  type TrackingGateway,
} from './providers/gateway.js';

/**
 * The tracking hub's configuration (M54, D-968), parsed here rather than in `serverEnv()` for the
 * reason `inbox.config.ts` gives: the shared file is edited by parallel milestones.
 *
 * - `TRACKING_PROVIDER`: `fake` (the default) records what would be sent and answers success;
 *   `live` sends to Meta's Conversions API and GA4's Measurement Protocol. The adapters are
 *   UNVERIFIED, so `live` also needs `TRACKING_ENABLED=true` (D-257's two keys), or the process
 *   stops at boot.
 * - The old names (`STOREFRONT_TRACKING_PROVIDER`, `STOREFRONT_TRACKING_ENABLED`, its base URLs
 *   and timeout) are read when the new ones are absent, so a server set up for M35b keeps its
 *   choice.
 * - `TRACKING_META_BASE_URL`, `TRACKING_GA4_BASE_URL`: the platforms' hosts (tests point them at
 *   a stand-in). `TRACKING_TIMEOUT_MS`: each call (10 s).
 */
const url = z
  .string()
  .url()
  .transform((value) => value.replace(/\/+$/, ''));

const schema = z.object({
  TRACKING_PROVIDER: z.enum(['fake', 'live']).default('fake'),
  TRACKING_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  TRACKING_META_BASE_URL: url.default('https://graph.facebook.com'),
  TRACKING_GA4_BASE_URL: url.default('https://www.google-analytics.com'),
  TRACKING_TIMEOUT_MS: z.coerce.number().int().min(500).max(30_000).default(10_000),
});

export type TrackingConfig = z.infer<typeof schema>;

export const TRACKING_CONFIG = Symbol('TrackingConfig');

const RENAMED: Readonly<Record<string, string>> = {
  TRACKING_PROVIDER: 'STOREFRONT_TRACKING_PROVIDER',
  TRACKING_ENABLED: 'STOREFRONT_TRACKING_ENABLED',
  TRACKING_META_BASE_URL: 'STOREFRONT_TRACKING_META_BASE_URL',
  TRACKING_GA4_BASE_URL: 'STOREFRONT_TRACKING_GA4_BASE_URL',
  TRACKING_TIMEOUT_MS: 'STOREFRONT_TRACKING_TIMEOUT_MS',
};

export function trackingConfig(source: NodeJS.ProcessEnv = process.env): TrackingConfig {
  // `KEY=` in a dotenv file is an empty string, not an absent key (the intake's lesson).
  const value = (key: string): string | undefined => {
    const given = source[key];
    return given === undefined || given === '' ? undefined : given;
  };
  const present: Record<string, string> = {};
  for (const key of Object.keys(RENAMED)) {
    const given = value(key) ?? value(RENAMED[key] ?? '');
    if (given !== undefined) present[key] = given;
  }
  const parsed = schema.safeParse(present);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .sort()
      .join('\n');
    throw new Error(`Invalid tracking configuration:\n${problems}`);
  }
  if (parsed.data.TRACKING_PROVIDER === 'live' && !parsed.data.TRACKING_ENABLED) {
    // D-257's two keys: naming unverified adapters is not switching them on.
    throw new Error(
      'TRACKING_PROVIDER=live names unverified Meta and GA4 adapters (D-968). Set ' +
        'TRACKING_ENABLED=true as well to send events before they have been verified.',
    );
  }
  return parsed.data;
}

export function trackingGatewayFor(config: TrackingConfig): TrackingGateway {
  return config.TRACKING_PROVIDER === 'live'
    ? new LiveTrackingGateway({
        metaBaseUrl: config.TRACKING_META_BASE_URL,
        ga4BaseUrl: config.TRACKING_GA4_BASE_URL,
        timeoutMs: config.TRACKING_TIMEOUT_MS,
      })
    : new FakeTrackingGateway();
}
