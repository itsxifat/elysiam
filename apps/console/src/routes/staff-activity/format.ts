import type { Period } from './api.js';
import type { StaffSearch } from './routes.js';
import type { StaffT } from './messages.js';

/**
 * Staff activity's small formatters (M57): hours from milliseconds, minutes from seconds, a rate
 * in tenths, a share in basis points. Integers in, text out; no money here (money is `<Money>`).
 */

export function hoursText(ms: number, t: StaffT): string {
  const minutes = Math.floor(ms / 60_000);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h === 0 ? t('staff.minutesShort', { m }) : t('staff.hours', { h, m });
}

export function secondsText(seconds: number | null, t: StaffT): string {
  if (seconds === null) return t('staff.none');
  if (seconds < 60) return t('staff.secondsShort', { s: seconds });
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? t('staff.minutesShort', { m: minutes }) : hoursText(seconds * 1000, t);
}

/** 12 tenths is "1.2". */
export function tenthsText(tenths: number | null, t: StaffT): string {
  if (tenths === null) return t('staff.none');
  return `${String(Math.trunc(tenths / 10))}.${String(Math.abs(tenths % 10))}`;
}

/** 9050 basis points is "90.5%". */
export function bpsText(bps: number | null, t: StaffT): string {
  if (bps === null) return t('staff.none');
  return `${String(Math.trunc(bps / 100))}.${String(Math.trunc((bps % 100) / 10))}%`;
}

/** A Dhaka time of day, 24-hour. */
export function timeOfDay(iso: string | null, t: StaffT): string {
  if (iso === null) return t('staff.none');
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dhaka',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

export function dateTimeText(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dhaka',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

export function dayText(date: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(new Date(`${date}T00:00:00Z`));
}

export function dhakaToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

export function addDays(date: string, days: number): string {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

export function daysInclusive(from: string, to: string): number {
  return (
    Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1
  );
}

/** The change from `before` to `now`, as a card's delta; null with nothing to compare. */
export function deltaOf(
  now: number,
  before: number | null | undefined,
  options: { readonly lowerIsBetter?: boolean; readonly caption: string },
):
  | {
      label: string;
      direction: 'up' | 'down' | 'flat';
      tone: 'positive' | 'negative' | 'neutral';
      caption: string;
    }
  | undefined {
  if (before === null || before === undefined) return undefined;
  if (before === 0 && now === 0) return undefined;
  const direction = now > before ? 'up' : now < before ? 'down' : 'flat';
  const good = options.lowerIsBetter === true ? direction === 'down' : direction === 'up';
  const pct = before === 0 ? null : Math.round(((now - before) * 100) / before);
  return {
    label: pct === null ? (now > 0 ? '+' : '0') : `${pct > 0 ? '+' : ''}${String(pct)}%`,
    direction,
    tone: direction === 'flat' ? 'neutral' : good ? 'positive' : 'negative',
    caption: options.caption,
  };
}

/** The longest period the server reads at once (`STAFF_ACTIVITY_MAX_DAYS`). */
const MAX_DAYS = 92;

/** The period a screen shows: the search's, else today. Never longer than the server reads. */
export function periodOf(search: StaffSearch): Period {
  const today = dhakaToday();
  const to = search.to ?? today;
  const from = search.from ?? to;
  if (from > to || daysInclusive(from, to) > MAX_DAYS) return { from: to, to };
  return { from, to };
}
