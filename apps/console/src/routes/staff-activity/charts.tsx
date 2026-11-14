import { cn } from '@elysium/ui';
import { useState } from 'react';

import type { PersonPage } from './api.js';
import { dayText, hoursText } from './format.js';
import { useStaffT } from './messages.js';

/**
 * A person's two pictures (M57): active hours by day as columns, and when in the week they work
 * as a heatmap. One series each, so no legend box (the section title names it); one hue, the
 * accent token, light to dark for the heatmap's magnitude. Every column and cell can take focus
 * and says its figure on hover and to a screen reader, and the days are also a table below.
 */

const WIDTH = 720;
const HEIGHT = 160;

/** A column with a 4 px rounded top and a square foot on the baseline. */
function column(x: number, width: number, h: number): string {
  const r = Math.min(4, width / 2, h);
  const base = HEIGHT - 1;
  const top = base - h;
  const x1 = x + width;
  return `M${String(x)} ${String(base)} V${String(top + r)} Q${String(x)} ${String(top)} ${String(x + r)} ${String(top)} H${String(x1 - r)} Q${String(x1)} ${String(top)} ${String(x1)} ${String(top + r)} V${String(base)} Z`;
}

export function DaysChart({ days }: { readonly days: PersonPage['days'] }) {
  const t = useStaffT();
  const [active, setActive] = useState<number | null>(null);
  const max = Math.max(1, ...days.map((day) => day.activeMs));
  const actionsOf = (day: PersonPage['days'][number]) =>
    Object.values(day.actions).reduce((sum, n) => sum + (n ?? 0), 0);
  const shown = active === null ? null : days[active];
  return (
    <figure className="space-y-3">
      <div className="relative">
        <svg
          viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`}
          className="h-40 w-full"
          role="list"
          aria-label={t('staff.chart.days')}
          preserveAspectRatio="none"
        >
          <line
            x1={0}
            x2={WIDTH}
            y1={HEIGHT - 0.5}
            y2={HEIGHT - 0.5}
            className="stroke-border"
            strokeWidth={1}
          />
          {days.map((day, index) => {
            const slot = WIDTH / Math.max(1, days.length);
            const barWidth = Math.max(1, Math.min(24, slot - 2));
            const x = index * slot + (slot - barWidth) / 2;
            const h = Math.round((day.activeMs / max) * (HEIGHT - 4));
            const label = t('staff.chart.dayTip', {
              date: dayText(day.date),
              hours: hoursText(day.activeMs, t),
              actions: actionsOf(day),
            });
            return (
              <g
                key={day.date}
                role="listitem"
                tabIndex={0}
                aria-label={label}

                onPointerEnter={() => {
                  setActive(index);
                }}
                onPointerLeave={() => {
                  setActive(null);
                }}
                onFocus={() => {
                  setActive(index);
                }}
                onBlur={() => {
                  setActive(null);
                }}
              >
                {/* The hit area: the whole slot, so the pointer finds a day, not a bar. */}
                <rect
                  x={index * slot}
                  y={0}
                  width={slot}
                  height={HEIGHT}
                  className="fill-primary opacity-0"
                />
                <title>{label}</title>
                {h <= 0 ? null : (
                  <path
                    d={column(x, barWidth, h)}
                    className={cn(
                      'fill-primary',
                      active !== null && active !== index ? 'opacity-50' : 'opacity-100',
                    )}
                  />
                )}
              </g>
            );
          })}
        </svg>
        {shown === null || shown === undefined ? null : (
          <p
            className="pointer-events-none absolute top-0 right-0 rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-sm"
            aria-hidden="true"
          >
            {t('staff.chart.dayTip', {
              date: dayText(shown.date),
              hours: hoursText(shown.activeMs, t),
              actions: actionsOf(shown),
            })}
          </p>
        )}
      </div>
      <div className="flex justify-between text-xs text-muted-foreground tabular-nums">
        <span>{days[0] === undefined ? '' : dayText(days[0].date)}</span>
        <span>{days.at(-1) === undefined ? '' : dayText(days.at(-1)?.date ?? '')}</span>
      </div>
      <details className="text-sm">
        <summary className="cursor-pointer text-muted-foreground">
          {t('staff.chart.daysTable')}
        </summary>
        <table className="mt-2 w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th scope="col" className="py-1.5">
                {t('staff.chart.date')}
              </th>
              <th scope="col" className="py-1.5 text-right">
                {t('staff.chart.hours')}
              </th>
              <th scope="col" className="py-1.5 text-right">
                {t('staff.chart.actions')}
              </th>
              <th scope="col" className="py-1.5 text-right">
                {t('staff.col.mistakes')}
              </th>
            </tr>
          </thead>
          <tbody>
            {days.map((day) => (
              <tr key={day.date} className="h-8 border-b border-border/60">
                <td>{dayText(day.date)}</td>
                <td className="text-right tabular-nums">{hoursText(day.activeMs, t)}</td>
                <td className="text-right tabular-nums">{actionsOf(day)}</td>
                <td className="text-right tabular-nums">{day.mistakes}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

/** Five steps of the accent, light to dark: none, then quartiles of the busiest hour. */
// Classes the console already ships (the first download's budget): no new utility for this.
const STEPS = [
  'bg-muted',
  'bg-primary/10',
  'bg-primary opacity-40',
  'bg-primary opacity-70',
  'bg-primary',
];

export function Heatmap({ cells }: { readonly cells: PersonPage['heatmap'] }) {
  const t = useStaffT();
  const max = Math.max(1, ...cells.flat());
  const step = (minutes: number) =>
    minutes === 0 ? 0 : Math.min(4, 1 + Math.floor(((minutes - 1) / max) * 4));
  // Saturday first: the Dhaka working week.
  const order = [6, 0, 1, 2, 3, 4, 5];
  return (
    <figure className="space-y-2">
      <figcaption className="text-xs text-muted-foreground">{t('staff.heat.caption')}</figcaption>
      <div
        className="overflow-x-auto rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        role="region"
        aria-label={t('staff.heat.title')}
        tabIndex={0}
      >
        <div className="space-y-0.5">
          <div className="flex gap-0.5">
            <span className="w-10 shrink-0" />
            {Array.from({ length: 24 }, (_, hour) => (
              <span
                key={hour}
                className="flex-1 text-center text-2xs text-muted-foreground tabular-nums"
              >
                {hour % 3 === 0 ? String(hour).padStart(2, '0') : ''}
              </span>
            ))}
          </div>
          {order.map((day) => (
            <div key={day} className="flex gap-0.5">
              <span className="w-10 shrink-0 text-xs text-muted-foreground">
                {t(`staff.day.${String(day) as '0'}`)}
              </span>
              {(cells[day] ?? []).map((minutes, hour) => {
                const label = t('staff.heat.cell', {
                  day: t(`staff.day.${String(day) as '0'}`),
                  hour: String(hour).padStart(2, '0'),
                  minutes,
                });
                return (
                  <span
                    key={hour}
                    role="img"
                    aria-label={label}
                    title={label}
                    className={cn('h-4 flex-1 rounded-sm', STEPS[step(minutes)])}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <div className="flex items-center justify-end gap-1 text-xs text-muted-foreground">
        <span>{t('staff.heat.less')}</span>
        {STEPS.map((className) => (
          <span key={className} aria-hidden="true" className={cn('size-3 rounded-sm', className)} />
        ))}
        <span>{t('staff.heat.more')}</span>
      </div>
    </figure>
  );
}
