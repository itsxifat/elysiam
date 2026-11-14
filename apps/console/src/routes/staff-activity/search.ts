import type { Desk } from './api.js';
import type { StaffSearch } from './routes.js';

/**
 * The search params of staff activity's screens, checked (M57). In the lazy chunk, not the
 * router: the route only declares the type (the first download's budget, M05 check 5), and each
 * screen reads its params through this, so a hand-edited address cannot ask for nonsense.
 */
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DESKS = new Set(['orders', 'inbox', 'calls', 'packing', 'returns']);
const TABS = new Set(['overview', 'timeline', 'mistakes']);
const STATUSES = new Set(['unreviewed', 'confirmed', 'dismissed']);
const VIEWS = new Set(['mistakes', 'settings']);

export function staffSearch(search: Record<string, unknown>): StaffSearch {
  const text = (value: unknown) => (typeof value === 'string' && value !== '' ? value : undefined);
  const date = (value: unknown) => {
    const v = text(value);
    return v !== undefined && DATE.test(v) ? v : undefined;
  };
  const from = date(search.from);
  const to = date(search.to);
  const day = date(search.day);
  const desk = text(search.desk);
  const tab = text(search.tab);
  const person = text(search.person);
  const who = text(search.who);
  const kind = text(search.kind);
  const status = text(search.status);
  const view = text(search.view);
  return {
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    ...(day === undefined ? {} : { day }),
    ...(desk !== undefined && DESKS.has(desk) ? { desk: desk as Desk } : {}),
    ...(tab !== undefined && TABS.has(tab) ? { tab: tab as StaffSearch['tab'] & string } : {}),
    ...(person === undefined ? {} : { person }),
    ...(who === undefined ? {} : { who }),
    ...(kind === undefined ? {} : { kind }),
    ...(view !== undefined && VIEWS.has(view)
      ? { view: view as StaffSearch['view'] & string }
      : {}),
    ...(status !== undefined && STATUSES.has(status)
      ? { status: status as StaffSearch['status'] & string }
      : {}),
  };
}
