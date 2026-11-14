import {
  Button,
  ErrorState,
  Skeleton,
  TabList,
  tabActiveClassName,
  tabClassName,
  cn,
} from '@elysium/ui';
import { useQuery } from '@tanstack/react-query';

import { myPage, personPage, STAFF_KEY } from './api.js';
import { MistakesView } from './mistakes-view.js';
import { useStaffT } from './messages.js';
import { LiveBadge, PersonOverview } from './person-view.js';
import type { StaffSearch } from './routes.js';
import { periodOf, PeriodBar } from './staff-nav.js';
import { TimelineView } from './timeline-view.js';

/**
 * A person's page with its three tabs (M57): the overview, the timeline, the mistakes. `userId`
 * null is the viewer's own page (`/v1/staff-activity/me`), which every desk role may read.
 */
export function PersonScreen({
  userId,
  search,
  go,
  header,
}: {
  readonly userId: string | null;
  readonly search: StaffSearch;
  readonly go: (next: Partial<StaffSearch>) => void;
  readonly header: (page: { name: string; live: React.ReactNode } | null) => React.ReactNode;
}) {
  const t = useStaffT();
  const period = periodOf(search);
  const tab = search.tab ?? 'overview';
  const page = useQuery({
    queryKey: [...STAFF_KEY, 'person', userId ?? 'me', period.from, period.to, search.desk ?? null],
    queryFn: () =>
      userId === null ? myPage(period, search.desk) : personPage(userId, period, search.desk),
  });
  const own = userId === null;
  const subject = page.data?.person.userId ?? userId;

  const tabButton = (value: NonNullable<StaffSearch['tab']>, label: string) => (
    <button
      type="button"
      className={cn(tabClassName, tab === value ? tabActiveClassName : '')}
      aria-current={tab === value ? 'page' : undefined}
      onClick={() => {
        go({ tab: value === 'overview' ? undefined : value });
      }}
    >
      {label}
    </button>
  );

  return (
    <div className="space-y-5">
      {header(
        page.data === undefined
          ? null
          : { name: page.data.person.name, live: <LiveBadge live={page.data.live} /> },
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <TabList label={t('staff.title')}>
          {tabButton('overview', t('staff.tab.overview'))}
          {tabButton('timeline', t('staff.tab.timeline'))}
          {tabButton('mistakes', own ? t('staff.tab.myMistakes') : t('staff.tab.mistakes'))}
        </TabList>
        {tab === 'timeline' ? null : (
          <PeriodBar
            period={period}
            desk={search.desk}
            withDesk={tab === 'overview'}
            onChange={(next) => {
              go(next);
            }}
          />
        )}
      </div>

      {tab === 'timeline' ? (
        subject === null ? (
          <Skeleton className="h-64 w-full" />
        ) : (
          <TimelineView
            userId={subject}
            day={search.day}
            onDay={(day) => {
              go({ day });
            }}
          />
        )
      ) : tab === 'mistakes' ? (
        subject === null ? (
          <Skeleton className="h-64 w-full" />
        ) : (
          <MistakesView period={period} userId={subject} search={search} onFilter={go} />
        )
      ) : page.isPending ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-busy="true">
          {Array.from({ length: 8 }, (_, index) => (
            <Skeleton key={index} className="h-32 w-full" />
          ))}
        </div>
      ) : page.isError ? (
        <ErrorState
          title={t('staff.failed')}
          action={
            <Button variant="outline" onClick={() => void page.refetch()}>
              {t('staff.retry')}
            </Button>
          }
        />
      ) : (
        <PersonOverview page={page.data} own={own} period={period} />
      )}
    </div>
  );
}
