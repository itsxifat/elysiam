import { createRoute, lazyRouteComponent, type AnyRoute } from '@tanstack/react-router';

import type { Desk } from './api.js';

/**
 * Staff activity's routes (M57), as a factory the router calls, every screen lazy (the first
 * download's budget). One route, `/staff-activity`: the team, or with `view` the mistakes or the
 * settings, or with `who` a person's page; My activity for staff. Each route costs the first
 * download a preload list and a component loader, so the section's views share one. The period, desk, tab and filters live in the search params so a view can
 * be shared as a link.
 */
export interface StaffSearch {
  readonly from?: string;
  readonly to?: string;
  readonly desk?: Desk;
  readonly tab?: 'overview' | 'timeline' | 'mistakes';
  /** A supervisor's section: the team (none), the mistakes or the settings. */
  readonly view?: 'mistakes' | 'settings';
  /** A person's page, for a supervisor: their user id. */
  readonly who?: string;
  readonly day?: string;
  readonly person?: string;
  readonly kind?: string;
  readonly status?: 'unreviewed' | 'confirmed' | 'dismissed';
}

export function staffActivityRoutes<TRoot extends AnyRoute>(rootRoute: TRoot) {
  const home = createRoute({
    getParentRoute: () => rootRoute,
    path: '/staff-activity',
    component: lazyRouteComponent(() => import('./staff-page.js'), 'StaffActivityPage'),
  });
  return [home] as const;
}
