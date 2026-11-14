import { PageHeader, PermissionGate } from '@elysium/ui';
import { useNavigate, useSearch } from '@tanstack/react-router';

import { useAbility, useOrgWide } from '../../auth/session.js';
import { useStaffT } from './messages.js';
import { PersonScreen } from './person-screen.js';
import type { StaffSearch } from './routes.js';
import { periodOf, PeriodBar, StaffNav } from './staff-nav.js';
import { TeamTable } from './team-table.js';
import { StaffMistakesPage } from './mistakes-page.js';
import { StaffSettingsPage } from './settings-page.js';
import { StaffPersonPage } from './person-page.js';
import { staffSearch } from './search.js';

/**
 * `/staff-activity` (M57, D-1000): a supervisor's team table, or for everyone else at a desk their
 * own page with their desk's comparison.
 */
export function StaffActivityPage() {
  const t = useStaffT();
  const ability = useAbility();
  const orgWide = useOrgWide();
  return (
    <PermissionGate
      allowed={ability.can('read', 'StaffActivity')}
      explain={{ title: t('staff.deniedTitle'), detail: t('staff.deniedDetail') }}
    >
      {orgWide('read', 'StaffActivity') ? <Supervisor /> : <Mine />}
    </PermissionGate>
  );
}

function useGo() {
  const search = staffSearch(useSearch({ from: '/staff-activity' }));
  const navigate = useNavigate();
  const go = (next: Partial<StaffSearch>) => {
    void navigate({ to: '/staff-activity', search: { ...search, ...next }, replace: true });
  };
  return { search, go };
}

/** A supervisor's section: the team, or the mistakes or the settings by `view`. */
function Supervisor() {
  const search = staffSearch(useSearch({ from: '/staff-activity' }));
  const view = search.view;
  if (search.who !== undefined) return <StaffPersonPage userId={search.who} search={search} />;
  if (view === 'mistakes') return <StaffMistakesPage />;
  if (view === 'settings') return <StaffSettingsPage />;
  return <Team />;
}

function Team() {
  const t = useStaffT();
  const { search, go } = useGo();
  const period = periodOf(search);
  return (
    <div className="space-y-5">
      <PageHeader
        title={t('staff.title')}
        description={t('staff.subtitle')}
        tabs={<StaffNav view={undefined} />}
        actions={<PeriodBar period={period} desk={search.desk} onChange={go} />}
      />
      <TeamTable period={period} desk={search.desk} />
    </div>
  );
}

function Mine() {
  const t = useStaffT();
  const { search, go } = useGo();
  return (
    <PersonScreen
      userId={null}
      search={search}
      go={go}
      header={() => (
        <PageHeader title={t('staff.mineTitle')} description={t('staff.mineSubtitle')} />
      )}
    />
  );
}
