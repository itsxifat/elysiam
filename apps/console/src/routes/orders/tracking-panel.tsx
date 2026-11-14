import { useQuery } from '@tanstack/react-query';

import { useAbility } from '../../auth/session.js';
import { useLocale, useT } from '../../i18n/locale.js';
import '../../i18n/web-marketing.js';
import { TrackingTable } from '../settings/tracking.js';
import { getOrderTracking } from '../settings/tracking-api.js';

/**
 * The order page's Tracking card (M54): what the hub sent the ad platforms for this order, at
 * each stage, and how each platform answered. Shown only to `read Tracking` (org_admin,
 * marketing); loaded with its own chunk, so the order page does not carry it otherwise.
 */
export function TrackingPanel({ orderId }: { readonly orderId: string }) {
  const t = useT();
  const { locale } = useLocale();
  const allowed = useAbility().can('read', 'Tracking');
  const query = useQuery({
    queryKey: ['tracking', 'order', orderId],
    queryFn: () => getOrderTracking(orderId),
    enabled: allowed,
  });
  if (!allowed || query.data === undefined) return null;
  return (
    <section
      aria-labelledby={`${orderId}-tracking`}
      className="space-y-3 rounded-lg border border-border bg-card p-5 text-sm"
    >
      <h2 id={`${orderId}-tracking`} className="text-base font-semibold tracking-tight">
        {t('wm.hub.orderCard')}
      </h2>
      {query.data.items.length === 0 ? (
        <p className="text-muted-foreground">{t('wm.hub.orderCardEmpty')}</p>
      ) : (
        <TrackingTable rows={query.data.items} locale={locale} />
      )}
    </section>
  );
}
