import { PageHeader, PermissionGate } from '@elysium/ui';
import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';

import { useAbility } from '../../auth/session.js';
import { useStaffT } from './messages.js';
import { PersonScreen } from './person-screen.js';
import type { StaffSearch } from './routes.js';

/** `/staff-activity?who=<user id>` (M57): a supervisor reading one person's page. */
export function StaffPersonPage({
  userId,
  search,
}: {
  readonly userId: string;
  readonly search: StaffSearch;
}) {
  const t = useStaffT();
  const ability = useAbility();
  const navigate = useNavigate();
  const go = (next: Partial<StaffSearch>) => {
    void navigate({ to: '/staff-activity', search: { ...search, ...next }, replace: true });
  };
  return (
    <PermissionGate
      allowed={ability.can('read', 'StaffActivity')}
      explain={{ title: t('staff.deniedTitle'), detail: t('staff.deniedDetail') }}
    >
      <PersonScreen
        userId={userId}
        search={search}
        go={go}
        header={(page) => (
          <PageHeader
            eyebrow={
              <Link
                to="/staff-activity"
                search={{
                  ...(search.from === undefined ? {} : { from: search.from }),
                  ...(search.to === undefined ? {} : { to: search.to }),
                }}
                className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
              >
                <ArrowLeft aria-hidden="true" className="size-4" />
                {t('staff.back')}
              </Link>
            }
            title={page?.name ?? t('staff.loading')}
            meta={page?.live}
          />
        )}
      />
    </PermissionGate>
  );
}
