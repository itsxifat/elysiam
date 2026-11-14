import { Money, Section, StatCard, StatusBadge, cn } from '@elysium/ui';
import { Link } from '@tanstack/react-router';

import { useLocale } from '../../i18n/locale.js';
import type { ComparisonRow, Desk, HeadlineFigure, Period, PersonPage } from './api.js';
import { DaysChart, Heatmap } from './charts.js';
import { deltaOf, hoursText, secondsText, tenthsText, timeOfDay } from './format.js';
import { isStaffKey, useStaffT, type StaffT } from './messages.js';

/**
 * A person's page, the overview tab (M57): the figures against the last period and the team, the
 * days, the week's heatmap, their desk's comparison table and their mistakes by kind. The same
 * view serves a supervisor reading anyone's page and a person reading their own (D-1000): what it
 * shows of colleagues is only what the server put in the comparison table.
 */

const DESK_FIGURES: Readonly<Record<Desk, readonly HeadlineFigure[]>> = {
  orders: [
    'activeMs',
    'ordersConfirmed',
    'piecesConfirmed',
    'calls',
    'talkSeconds',
    'mistakeRateTenths',
  ],
  inbox: ['activeMs', 'messagesSent', 'calls', 'talkSeconds', 'mistakeRateTenths'],
  calls: ['activeMs', 'calls', 'talkSeconds', 'mistakeRateTenths'],
  packing: ['activeMs', 'packed', 'piecesPacked', 'mistakeRateTenths'],
  returns: ['activeMs', 'returnsClosed', 'returnsReceived', 'mistakeRateTenths'],
};

const FIGURE_LABEL = {
  activeMs: 'staff.col.active',
  onlineMs: 'staff.col.online',
  ordersConfirmed: 'staff.col.confirmed',
  piecesConfirmed: 'staff.col.pieces',
  messagesSent: 'staff.col.messages',
  calls: 'staff.col.calls',
  talkSeconds: 'staff.col.talk',
  packed: 'staff.col.packed',
  piecesPacked: 'staff.col.piecesPacked',
  returnsReceived: 'staff.col.returnsReceived',
  returnsClosed: 'staff.col.returnsClosed',
  mistakeRateTenths: 'staff.col.mistakeRate',
} as const satisfies Record<HeadlineFigure, Parameters<StaffT>[0]>;

function figureText(figure: HeadlineFigure, value: number | null, t: StaffT): string {
  if (value === null) return t('staff.none');
  if (figure === 'activeMs' || figure === 'onlineMs') return hoursText(value, t);
  if (figure === 'talkSeconds') return secondsText(value, t);
  if (figure === 'mistakeRateTenths') return tenthsText(value, t);
  return String(value);
}

export function LiveBadge({ live }: { readonly live: PersonPage['live'] }) {
  const t = useStaffT();
  if (live === null) return null;
  return (
    <span className="inline-flex items-center gap-2">
      <StatusBadge
        tone={live.state === 'active' ? 'success' : live.state === 'idle' ? 'warning' : 'neutral'}
      >
        {t(`staff.live.${live.state}`)}
      </StatusBadge>
      {live.paused ? <StatusBadge tone="neutral">{t('staff.live.paused')}</StatusBadge> : null}
    </span>
  );
}

export function PersonOverview({
  page,
  own,
  period,
}: {
  readonly page: PersonPage;
  readonly own: boolean;
  readonly period: Period;
}) {
  const t = useStaffT();
  const { locale } = useLocale();
  const now = page.figures;
  const before = page.previous;
  const caption = t('staff.vsPrevious');
  const desks = new Set(now.desks);
  const showAll = desks.size === 0;
  const median = (figure: HeadlineFigure) =>
    t('staff.vsMedian', { value: figureText(figure, page.medians[figure], t) });

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label={t('staff.card.active')}
          value={hoursText(now.presence.activeMs, t)}
          hint={t('staff.card.activeHint', {
            online: hoursText(now.presence.onlineMs, t),
            idle: hoursText(now.presence.idleMs, t),
          })}
          {...withDelta(deltaOf(now.presence.activeMs, before?.presence.activeMs, { caption }))}
        />
        {showAll || desks.has('orders') ? (
          <StatCard
            label={t('staff.card.confirmed')}
            value={String(now.orders.confirmed)}
            hint={
              <>
                {t('staff.card.confirmedHint', { pieces: now.orders.piecesConfirmed, value: '' })}
                <Money poisha={now.orders.valueConfirmedPoisha} locale={locale} compact />
                {' · '}
                {median('ordersConfirmed')}
              </>
            }
            {...withDelta(deltaOf(now.orders.confirmed, before?.orders.confirmed, { caption }))}
          />
        ) : null}
        {showAll || desks.has('inbox') ? (
          <StatCard
            label={t('staff.card.messages')}
            value={String(now.inbox.messagesSent)}
            hint={t('staff.card.messagesHint', {
              conversations: now.inbox.conversations,
              reply: secondsText(now.inbox.medianFirstReplySeconds, t),
            })}
            {...withDelta(deltaOf(now.inbox.messagesSent, before?.inbox.messagesSent, { caption }))}
          />
        ) : null}
        {showAll || desks.has('calls') || desks.has('orders') ? (
          <StatCard
            label={t('staff.card.calls')}
            value={String(now.calls.outbound + now.calls.answered)}
            hint={t('staff.card.callsHint', {
              talk: secondsText(now.calls.talkSeconds, t),
              missed: now.calls.missed,
            })}
            {...withDelta(
              deltaOf(
                now.calls.outbound + now.calls.answered,
                before === null ? null : before.calls.outbound + before.calls.answered,
                { caption },
              ),
            )}
          />
        ) : null}
        {showAll || desks.has('packing') ? (
          <StatCard
            label={t('staff.card.packed')}
            value={String(now.packing.packed)}
            hint={t('staff.card.packedHint', {
              pieces: now.packing.piecesPacked,
              time: secondsText(now.packing.medianPackSeconds, t),
            })}
            {...withDelta(deltaOf(now.packing.packed, before?.packing.packed, { caption }))}
          />
        ) : null}
        {showAll || desks.has('returns') ? (
          <StatCard
            label={t('staff.card.returns')}
            value={String(now.packing.returnsClosed)}
            hint={t('staff.card.returnsHint', {
              pieces: now.packing.piecesReturned,
              received: now.returns.received,
            })}
            {...withDelta(
              deltaOf(now.packing.returnsClosed, before?.packing.returnsClosed, { caption }),
            )}
          />
        ) : null}
        <StatCard
          label={t('staff.card.mistakes')}
          value={String(now.mistakes)}
          hint={`${t('staff.card.mistakesHint', { rate: tenthsText(now.mistakeRateTenths, t) })} · ${median('mistakeRateTenths')}`}
          {...withDelta(deltaOf(now.mistakes, before?.mistakes, { caption, lowerIsBetter: true }))}
          footer={
            page.mistakes.total === 0 ? undefined : (
              <Link
                to="/staff-activity"
                search={{
                  from: period.from,
                  to: period.to,
                  tab: 'mistakes',
                  ...(own ? {} : { who: page.person.userId }),
                }}
                className="text-sm hover:underline"
              >
                {t('staff.mistakesSummary', { count: page.mistakes.total })}
              </Link>
            )
          }
        />
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        <Section title={t('staff.chart.days')}>
          <DaysChart days={page.days} />
        </Section>
        <Section title={t('staff.heat.title')}>
          <Heatmap cells={page.heatmap} />
        </Section>
      </div>

      <Comparison page={page} own={own} />

      {Object.keys(page.mistakes.byKind).length === 0 ? null : (
        <Section title={t('staff.col.mistakes')}>
          <ul className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            {Object.entries(page.mistakes.byKind)
              .sort((a, b) => b[1] - a[1])
              .map(([kind, n]) => {
                const key = `staff.mistake.${kind}`;
                return (
                  <li key={kind} className="flex justify-between border-b border-border/60 py-1.5">
                    <span>{isStaffKey(key) ? t(key) : kind}</span>
                    <span className="tabular-nums">{n}</span>
                  </li>
                );
              })}
          </ul>
        </Section>
      )}

      {now.presence.firstSeenAt === null ? null : (
        <p className="text-xs text-muted-foreground">
          {t('staff.col.firstSeen')}: {timeOfDay(now.presence.firstSeenAt, t)}
        </p>
      )}
    </div>
  );
}

function withDelta(delta: ReturnType<typeof deltaOf>) {
  return delta === undefined ? {} : { delta };
}

function rowName(row: ComparisonRow, t: StaffT): string {
  if (row.isViewer && row.name === null) return t('staff.compare.you');
  if (row.name !== null) return row.name;
  return t('staff.compare.colleague', { n: row.colleagueNo ?? 0 });
}

function Comparison({ page, own }: { readonly page: PersonPage; readonly own: boolean }) {
  const t = useStaffT();
  const desk = page.comparison.desk;
  const figures = desk === null ? DESK_FIGURES.orders : DESK_FIGURES[desk];
  const rows = page.comparison.rows;
  return (
    <Section
      title={own ? t('staff.compare.title') : t('staff.compare.titleOf')}
      description={t('staff.compare.caption', {
        desk: desk === null ? t('staff.desk.all') : t(`staff.desk.${desk}`),
      })}
    >
      {rows.length <= 1 ? (
        <p className="text-sm text-muted-foreground">{t('staff.compare.empty')}</p>
      ) : (
        <div
          className="overflow-x-auto rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          role="region"
          aria-label={own ? t('staff.compare.title') : t('staff.compare.titleOf')}
          tabIndex={0}
        >
          <table className="w-full text-sm">
            <caption className="sr-only">{t('staff.compare.title')}</caption>
            <thead>
              <tr className="border-b border-border text-xs text-muted-foreground">
                <th scope="col" className="py-2 text-left font-medium">
                  {t('staff.col.person')}
                </th>
                {figures.map((figure) => (
                  <th key={figure} scope="col" className="py-2 text-right font-medium">
                    {t(FIGURE_LABEL[figure])}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr
                  key={row.userId ?? `colleague-${String(row.colleagueNo ?? index)}`}
                  className={cn('h-9 border-b border-border/60', row.isViewer ? 'bg-selected' : '')}
                  aria-current={row.isViewer ? 'true' : undefined}
                >
                  <th scope="row" className="py-1.5 text-left font-normal">
                    {row.isViewer ? (
                      <span className="font-medium">{rowName(row, t)}</span>
                    ) : (
                      rowName(row, t)
                    )}
                  </th>
                  {figures.map((figure) => (
                    <td key={figure} className="py-1.5 text-right tabular-nums">
                      {figureText(figure, row.figures[figure], t)}
                      {row.ranks[figure] === null ? null : (
                        <span className="ml-1.5 text-xs text-muted-foreground">
                          #{String(row.ranks[figure])}
                        </span>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}
