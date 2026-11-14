import {
  Button,
  EmptyState,
  ErrorState,
  Skeleton,
  StatusBadge,
  buttonVariants,
  cn,
} from '@elysium/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowDown, ArrowUp, Download } from 'lucide-react';
import { useMemo, useState } from 'react';

import {
  STAFF_KEY,
  teamExportUrl,
  teamTable,
  type Desk,
  type Figures,
  type Period,
} from './api.js';
import { bpsText, hoursText, secondsText, tenthsText } from './format.js';
import { useStaffT, type StaffKey, type StaffT } from './messages.js';

/**
 * The team table (M57): one row per person for the period, grouped columns, the team median at
 * the foot, sortable, with a CSV of the same. Each name opens the person's page for the period.
 */

interface Column {
  readonly key: string;
  readonly label: StaffKey;
  readonly group: StaffKey;
  /** The figure the column sorts by (null sorts last). */
  readonly value: (figures: Figures) => number | null;
  readonly render: (figures: Figures, t: StaffT) => string;
  /** The median's key, when the server reports one for this column. */
  readonly median?:
    | 'activeMs'
    | 'onlineMs'
    | 'ordersConfirmed'
    | 'piecesConfirmed'
    | 'messagesSent'
    | 'calls'
    | 'talkSeconds'
    | 'packed'
    | 'piecesPacked'
    | 'returnsClosed'
    | 'mistakeRateTenths';
  readonly renderMedian?: (value: number, t: StaffT) => string;
  readonly lowerIsBetter?: boolean;
}

const count = (value: number) => String(value);

const COLUMNS: readonly Column[] = [
  {
    key: 'active',
    label: 'staff.col.active',
    group: 'staff.group.time',
    value: (f) => f.presence.activeMs,
    render: (f, t) => hoursText(f.presence.activeMs, t),
    median: 'activeMs',
    renderMedian: (v, t) => hoursText(v, t),
  },
  {
    key: 'online',
    label: 'staff.col.online',
    group: 'staff.group.time',
    value: (f) => f.presence.onlineMs,
    render: (f, t) => hoursText(f.presence.onlineMs, t),
    median: 'onlineMs',
    renderMedian: (v, t) => hoursText(v, t),
  },
  {
    key: 'idle',
    label: 'staff.col.idle',
    group: 'staff.group.time',
    value: (f) => f.presence.idleMs,
    render: (f, t) => hoursText(f.presence.idleMs, t),
    lowerIsBetter: true,
  },
  {
    key: 'taken',
    label: 'staff.col.taken',
    group: 'staff.group.orders',
    value: (f) => f.orders.taken,
    render: (f) => count(f.orders.taken),
  },
  {
    key: 'confirmed',
    label: 'staff.col.confirmed',
    group: 'staff.group.orders',
    value: (f) => f.orders.confirmed,
    render: (f) => count(f.orders.confirmed),
    median: 'ordersConfirmed',
    renderMedian: count,
  },
  {
    key: 'cancelled',
    label: 'staff.col.cancelled',
    group: 'staff.group.orders',
    value: (f) => f.orders.cancelled,
    render: (f) => count(f.orders.cancelled),
    lowerIsBetter: true,
  },
  {
    key: 'pieces',
    label: 'staff.col.pieces',
    group: 'staff.group.orders',
    value: (f) => f.orders.piecesConfirmed,
    render: (f) => count(f.orders.piecesConfirmed),
    median: 'piecesConfirmed',
    renderMedian: count,
  },
  {
    key: 'callAttempts',
    label: 'staff.col.callAttempts',
    group: 'staff.group.orders',
    value: (f) => f.orders.callAttempts,
    render: (f) => count(f.orders.callAttempts),
  },
  {
    key: 'delivered',
    label: 'staff.col.deliveryRate',
    group: 'staff.group.orders',
    value: (f) => f.deliveryRateBps,
    render: (f, t) => bpsText(f.deliveryRateBps, t),
  },
  {
    key: 'messages',
    label: 'staff.col.messages',
    group: 'staff.group.inbox',
    value: (f) => f.inbox.messagesSent,
    render: (f) => count(f.inbox.messagesSent),
    median: 'messagesSent',
    renderMedian: count,
  },
  {
    key: 'firstReply',
    label: 'staff.col.firstReply',
    group: 'staff.group.inbox',
    value: (f) => f.inbox.medianFirstReplySeconds,
    render: (f, t) => secondsText(f.inbox.medianFirstReplySeconds, t),
    lowerIsBetter: true,
  },
  {
    key: 'calls',
    label: 'staff.col.calls',
    group: 'staff.group.inbox',
    value: (f) => f.calls.outbound + f.calls.answered,
    render: (f) => count(f.calls.outbound + f.calls.answered),
    median: 'calls',
    renderMedian: count,
  },
  {
    key: 'talk',
    label: 'staff.col.talk',
    group: 'staff.group.inbox',
    value: (f) => f.calls.talkSeconds,
    render: (f, t) => secondsText(f.calls.talkSeconds, t),
    median: 'talkSeconds',
    renderMedian: (v, t) => secondsText(v, t),
  },
  {
    key: 'missed',
    label: 'staff.col.missed',
    group: 'staff.group.inbox',
    value: (f) => f.calls.missed,
    render: (f) => count(f.calls.missed),
    lowerIsBetter: true,
  },
  {
    key: 'packed',
    label: 'staff.col.packed',
    group: 'staff.group.hub',
    value: (f) => f.packing.packed,
    render: (f) => count(f.packing.packed),
    median: 'packed',
    renderMedian: count,
  },
  {
    key: 'piecesPacked',
    label: 'staff.col.piecesPacked',
    group: 'staff.group.hub',
    value: (f) => f.packing.piecesPacked,
    render: (f) => count(f.packing.piecesPacked),
    median: 'piecesPacked',
    renderMedian: count,
  },
  {
    key: 'packTime',
    label: 'staff.col.packTime',
    group: 'staff.group.hub',
    value: (f) => f.packing.medianPackSeconds,
    render: (f, t) => secondsText(f.packing.medianPackSeconds, t),
    lowerIsBetter: true,
  },
  {
    key: 'returnsClosed',
    label: 'staff.col.returnsClosed',
    group: 'staff.group.hub',
    value: (f) => f.packing.returnsClosed,
    render: (f) => count(f.packing.returnsClosed),
    median: 'returnsClosed',
    renderMedian: count,
  },
  {
    key: 'returnsReceived',
    label: 'staff.col.returnsReceived',
    group: 'staff.group.hub',
    value: (f) => f.returns.received,
    render: (f) => count(f.returns.received),
  },
  {
    key: 'mistakes',
    label: 'staff.col.mistakes',
    group: 'staff.group.quality',
    value: (f) => f.mistakes,
    render: (f) => count(f.mistakes),
    lowerIsBetter: true,
  },
  {
    key: 'rate',
    label: 'staff.col.mistakeRate',
    group: 'staff.group.quality',
    value: (f) => f.mistakeRateTenths,
    render: (f, t) => tenthsText(f.mistakeRateTenths, t),
    median: 'mistakeRateTenths',
    renderMedian: (v, t) => tenthsText(v, t),
    lowerIsBetter: true,
  },
];

/** The column groups in order, each with how many columns it spans. */
function groups(): { label: StaffKey; span: number }[] {
  const out: { label: StaffKey; span: number }[] = [];
  for (const column of COLUMNS) {
    const last = out.at(-1);
    if (last?.label === column.group) last.span += 1;
    else out.push({ label: column.group, span: 1 });
  }
  return out;
}

export function TeamTable({
  period,
  desk,
}: {
  readonly period: Period;
  readonly desk: Desk | undefined;
}) {
  const t = useStaffT();
  const [sort, setSort] = useState<{ key: string; descending: boolean }>({
    key: 'active',
    descending: true,
  });
  const table = useQuery({
    queryKey: [...STAFF_KEY, 'team', period.from, period.to, desk ?? 'all'],
    queryFn: () => teamTable(period, desk),
  });

  const rows = useMemo(() => {
    const column = COLUMNS.find((one) => one.key === sort.key) ?? COLUMNS[0];
    const people = [...(table.data?.people ?? [])];
    if (column === undefined) return people;
    return people.sort((a, b) => {
      const x = column.value(a.figures);
      const y = column.value(b.figures);
      if (x === null && y === null) return 0;
      if (x === null) return 1;
      if (y === null) return -1;
      return sort.descending ? y - x : x - y;
    });
  }, [table.data, sort]);

  if (table.isPending) {
    return (
      <div className="space-y-2" aria-busy="true">
        {Array.from({ length: 6 }, (_, index) => (
          <Skeleton key={index} className="h-9 w-full" />
        ))}
      </div>
    );
  }
  if (table.isError) {
    return (
      <ErrorState
        title={t('staff.failed')}
        action={
          <Button variant="outline" onClick={() => void table.refetch()}>
            {t('staff.retry')}
          </Button>
        }
      />
    );
  }
  if (rows.length === 0) {
    return <EmptyState title={t('staff.emptyTitle')} detail={t('staff.emptyTeam')} />;
  }

  const medians = table.data.medians;
  return (
    <section className="space-y-3">
      <div className="flex justify-end">
        <a
          href={teamExportUrl(period, desk)}
          className={buttonVariants({ variant: 'outline', size: 'sm' })}
        >
          <Download aria-hidden="true" className="size-4" />
          {t('staff.export')}
        </a>
      </div>
      <div
        className="overflow-x-auto rounded-lg border border-border focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        role="region"
        aria-label={t('staff.tab.team')}
        tabIndex={0}
      >
        <table className="w-full text-sm whitespace-nowrap">
          <caption className="sr-only">{t('staff.tab.team')}</caption>
          <thead>
            <tr className="border-b border-border text-xs text-muted-foreground">
              <th scope="col" className="sticky left-0 bg-card" />
              {groups().map((group) => (
                <th
                  key={group.label}
                  scope="colgroup"
                  colSpan={group.span}
                  className="border-l border-border px-2 py-1.5 text-left font-medium"
                >
                  {t(group.label)}
                </th>
              ))}
            </tr>
            <tr className="border-b border-border text-xs text-muted-foreground">
              <th scope="col" className="sticky left-0 bg-card px-3 py-2 text-left font-medium">
                {t('staff.col.person')}
              </th>
              {COLUMNS.map((column) => {
                const sorted = sort.key === column.key;
                return (
                  <th
                    key={column.key}
                    scope="col"
                    aria-sort={sorted ? (sort.descending ? 'descending' : 'ascending') : 'none'}
                    className="px-2 py-2 text-right font-medium"
                  >
                    <button
                      type="button"
                      aria-label={t('staff.sortBy', { column: t(column.label) })}
                      className="inline-flex items-center gap-1 rounded-sm hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                      onClick={() => {
                        setSort((current) =>
                          current.key === column.key
                            ? { key: column.key, descending: !current.descending }
                            : { key: column.key, descending: column.lowerIsBetter !== true },
                        );
                      }}
                    >
                      {t(column.label)}
                      {sorted ? (
                        sort.descending ? (
                          <ArrowDown aria-hidden="true" className="size-3" />
                        ) : (
                          <ArrowUp aria-hidden="true" className="size-3" />
                        )
                      ) : null}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ person, figures }) => (
              <tr key={figures.userId} className="h-9 border-b border-border/60 hover:bg-accent/40">
                <th
                  scope="row"
                  className="sticky left-0 bg-card px-3 py-1.5 text-left font-normal whitespace-nowrap"
                >
                  <Link
                    to="/staff-activity"
                    search={{ from: period.from, to: period.to, who: figures.userId }}
                    className="rounded-sm font-medium hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  >
                    {person?.name === undefined || person.name === ''
                      ? figures.userId
                      : person.name}
                  </Link>
                  {person !== null && !person.active ? (
                    <StatusBadge tone="neutral" className="ml-2">
                      {t('staff.left')}
                    </StatusBadge>
                  ) : null}
                </th>
                {COLUMNS.map((column) => (
                  <td
                    key={column.key}
                    className={cn(
                      'px-2 py-1.5 text-right tabular-nums',
                      column.key === 'mistakes' && figures.mistakes > 0 ? 'font-medium' : '',
                    )}
                  >
                    {column.render(figures, t)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="h-9 text-xs text-muted-foreground">
              <th scope="row" className="sticky left-0 bg-card px-3 py-1.5 text-left font-medium">
                {t('staff.median')}
              </th>
              {COLUMNS.map((column) => {
                const value = column.median === undefined ? null : medians[column.median];
                return (
                  <td key={column.key} className="px-2 py-1.5 text-right tabular-nums">
                    {value === null || column.renderMedian === undefined
                      ? ''
                      : column.renderMedian(value, t)}
                  </td>
                );
              })}
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}
