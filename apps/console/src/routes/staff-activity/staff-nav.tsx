import { Select, TabList, cn, tabActiveClassName, tabClassName } from '@elysium/ui';
import { Link } from '@tanstack/react-router';

import { useAbility, useOrgWide } from '../../auth/session.js';
import { DateRangePicker } from '../../ui/date-picker.js';
import type { Desk, Period } from './api.js';
import { addDays, dhakaToday } from './format.js';

export { periodOf } from './format.js';

export const DESKS: readonly Desk[] = ['orders', 'inbox', 'calls', 'packing', 'returns'];
import { useStaffT } from './messages.js';
import type { StaffSearch } from './routes.js';

/** The tabs of a supervisor's section (D-1000): the team, the mistakes, and org_admin's settings. */
export function StaffNav({ view }: { readonly view: StaffSearch['view'] }) {
  const t = useStaffT();
  const ability = useAbility();
  const orgWide = useOrgWide();
  if (!orgWide('read', 'StaffActivity')) return null;
  const tab = (to: StaffSearch['view'], label: string) => (
    <Link
      to="/staff-activity"
      search={to === undefined ? {} : { view: to }}
      className={cn(tabClassName, view === to ? tabActiveClassName : '')}
      aria-current={view === to ? 'page' : undefined}
    >
      {label}
    </Link>
  );
  return (
    <TabList label={t('staff.title')}>
      {tab(undefined, t('staff.tab.team'))}
      {tab('mistakes', t('staff.tab.mistakes'))}
      {ability.can('update', 'StaffActivity') ? tab('settings', t('staff.tab.settings')) : null}
    </TabList>
  );
}

/** The period and, where it means something, the desk. */
export function PeriodBar({
  period,
  desk,
  onChange,
  withDesk = true,
}: {
  readonly period: Period;
  readonly desk: Desk | undefined;
  readonly onChange: (next: Partial<StaffSearch> & { desk?: Desk | undefined }) => void;
  readonly withDesk?: boolean;
}) {
  const t = useStaffT();
  const today = dhakaToday();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <DateRangePicker
        aria-label={t('staff.period')}
        value={period}
        max={today}
        min={addDays(today, -730)}
        onValueChange={(next) => {
          if (next.from !== '' && next.to !== '') onChange({ from: next.from, to: next.to });
        }}
      />
      {withDesk ? (
        <div className="w-44">
          <Select
            aria-label={t('staff.desk')}
            value={desk ?? 'all'}
            onValueChange={(value) => {
              onChange({ desk: value === 'all' ? undefined : (value as Desk) });
            }}
            options={[
              { value: 'all', label: t('staff.desk.all') },
              ...DESKS.map((one) => ({ value: one, label: t(`staff.desk.${one}`) })),
            ]}
          />
        </div>
      ) : null}
    </div>
  );
}
