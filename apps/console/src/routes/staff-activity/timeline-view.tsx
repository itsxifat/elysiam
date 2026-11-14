import { Button, EmptyState, ErrorState, Skeleton, cn } from '@elysium/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  Inbox,
  MonitorDot,
  Package,
  PhoneCall,
  RotateCcw,
  ShoppingCart,
  type LucideIcon,
} from 'lucide-react';

import { DatePicker } from '../../ui/date-picker.js';
import { STAFF_KEY, timeline, type StaffRef, type TimelineItem } from './api.js';
import { dhakaToday, secondsText, timeOfDay } from './format.js';
import { isStaffKey, useStaffT, type StaffT } from './messages.js';

/**
 * A person's timeline (M57): everything they did on one day, newest first, minute by minute,
 * each line linked to its order, conversation or call, with the stretches they were idle or away.
 */

const DESK_ICON: Readonly<Record<TimelineItem['desk'], LucideIcon>> = {
  orders: ShoppingCart,
  inbox: Inbox,
  calls: PhoneCall,
  packing: Package,
  returns: RotateCcw,
  presence: MonitorDot,
};

export function lineText(item: TimelineItem, t: StaffT): string {
  const values = {
    order: item.ref?.label ?? '',
    lot: String(item.detail.lot ?? ''),
    minutes: String(item.detail.minutes ?? ''),
  };
  const key = `staff.kind.${item.kind}`;
  if (isStaffKey(key)) return t(key, values);
  if (item.kind.startsWith('order.')) return t('staff.kind.order.other', values);
  return t('staff.kind.other');
}

function detailText(item: TimelineItem, t: StaffT): string | null {
  const parts: string[] = [];
  if (typeof item.detail.pieces === 'number')
    parts.push(t('staff.detail.pieces', { n: item.detail.pieces }));
  if (typeof item.detail.outcome === 'string') {
    const key = `staff.detail.outcome.${item.detail.outcome}`;
    if (isStaffKey(key)) parts.push(t(key));
  }
  if (typeof item.detail.talkSeconds === 'number') {
    parts.push(t('staff.detail.talk', { time: secondsText(item.detail.talkSeconds, t) }));
  } else if (item.desk === 'calls' && item.detail.answered === 0) {
    parts.push(t('staff.detail.notAnswered'));
  }
  return parts.length === 0 ? null : parts.join(' · ');
}

/** Where a reference leads: an order's page, the inbox at the conversation, the calls list. */
export function RefLink({
  refTo,
  children,
}: {
  readonly refTo: StaffRef;
  readonly children: React.ReactNode;
}) {
  const className =
    'rounded-sm text-sm hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none';
  if (refTo.type === 'conversation') {
    return (
      <Link to="/inbox" search={{ c: refTo.id } as never} className={className}>
        {children}
      </Link>
    );
  }
  if (refTo.type === 'call') {
    return (
      <Link to="/calls" className={className}>
        {children}
      </Link>
    );
  }
  if (refTo.type === 'order') {
    return (
      <Link to="/orders/$orderId" params={{ orderId: refTo.id }} className={className}>
        {children}
      </Link>
    );
  }
  return <span className="text-sm">{children}</span>;
}

export function TimelineView({
  userId,
  day,
  onDay,
}: {
  readonly userId: string;
  readonly day: string | undefined;
  readonly onDay: (day: string) => void;
}) {
  const t = useStaffT();
  const date = day ?? dhakaToday();
  const lines = useQuery({
    queryKey: [...STAFF_KEY, 'timeline', userId, date],
    queryFn: () => timeline(userId, { from: date, to: date }),
  });
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">{t('staff.timeline.day')}</span>
        <DatePicker
          aria-label={t('staff.timeline.day')}
          value={date}
          max={dhakaToday()}
          onValueChange={(next) => {
            if (next !== '') onDay(next);
          }}
        />
      </div>
      {lines.isPending ? (
        <div className="space-y-2" aria-busy="true">
          {Array.from({ length: 8 }, (_, index) => (
            <Skeleton key={index} className="h-8 w-full" />
          ))}
        </div>
      ) : lines.isError ? (
        <ErrorState
          title={t('staff.failed')}
          action={
            <Button variant="outline" onClick={() => void lines.refetch()}>
              {t('staff.retry')}
            </Button>
          }
        />
      ) : lines.data.items.length === 0 ? (
        <EmptyState title={t('staff.emptyTitle')} detail={t('staff.timeline.empty')} />
      ) : (
        <>
          {lines.data.truncated ? (
            <p className="text-xs text-muted-foreground">
              {t('staff.timeline.truncated', { count: lines.data.items.length })}
            </p>
          ) : null}
          <ol className="divide-y divide-border rounded-lg border border-border">
            {lines.data.items.map((item) => {
              const Icon = DESK_ICON[item.desk];
              const detail = detailText(item, t);
              const text = lineText(item, t);
              return (
                <li
                  key={item.id}
                  className={cn(
                    'flex min-h-8 items-center gap-3 px-3 py-1.5',
                    item.desk === 'presence' ? 'text-muted-foreground' : '',
                  )}
                >
                  <time
                    dateTime={item.at}
                    className="w-12 shrink-0 text-xs text-muted-foreground tabular-nums"
                  >
                    {timeOfDay(item.at, t)}
                  </time>
                  <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                  <span className="sr-only">{t(`staff.desk.${item.desk}`)}</span>
                  <span className="min-w-0 flex-1 text-sm">
                    {item.ref === null ? text : <RefLink refTo={item.ref}>{text}</RefLink>}
                    {detail === null ? null : (
                      <span className="ml-2 text-xs text-muted-foreground">{detail}</span>
                    )}
                  </span>
                </li>
              );
            })}
          </ol>
        </>
      )}
    </div>
  );
}
