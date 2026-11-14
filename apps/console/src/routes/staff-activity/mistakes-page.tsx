import { PageHeader, PermissionGate } from '@elysium/ui';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';

import { useOrgWide } from '../../auth/session.js';
import { mistakes, STAFF_KEY } from './api.js';
import { useStaffT } from './messages.js';
import { MistakesView } from './mistakes-view.js';
import type { StaffSearch } from './routes.js';
import { periodOf, PeriodBar, StaffNav } from './staff-nav.js';
import { staffSearch } from './search.js';

/** `/staff-activity?view=mistakes` (M57): every person's mistakes for a supervisor, with the reviews. */
export function StaffMistakesPage() {
  const t = useStaffT();
  const orgWide = useOrgWide();
  const search = staffSearch(useSearch({ from: '/staff-activity' }));
  const navigate = useNavigate();
  const go = (next: Partial<StaffSearch>) => {
    void navigate({
      to: '/staff-activity',
      search: { ...search, ...next },
      replace: true,
    });
  };
  const period = periodOf(search);
  // Who had mistakes in the period, for the person filter: the unfiltered list, which the view
  // shares whenever no filter is set.
  const everyone = useQuery({
    queryKey: [...STAFF_KEY, 'mistakes', period.from, period.to, {}],
    queryFn: () => mistakes(period, {}),
    enabled: orgWide('read', 'StaffActivity'),
  });
  const people = [
    ...new Map(
      (everyone.data?.items ?? []).map((item) => [
        item.userId,
        { userId: item.userId, name: item.name },
      ]),
    ).values(),
  ].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <PermissionGate
      allowed={orgWide('read', 'StaffActivity')}
      explain={{ title: t('staff.deniedTitle'), detail: t('staff.deniedDetail') }}
    >
      <div className="space-y-5">
        <PageHeader
          title={t('staff.title')}
          description={t('staff.subtitle')}
          tabs={<StaffNav view="mistakes" />}
          actions={<PeriodBar period={period} desk={undefined} withDesk={false} onChange={go} />}
        />
        <MistakesView
          period={period}
          userId={undefined}
          search={search}
          onFilter={go}
          people={people}
        />
      </div>
    </PermissionGate>
  );
}
