import { describe, expect, it } from 'vitest';

import { ZERO_ORDERS, ZERO_PACKING, type TimelineItem } from './facts.js';
import {
  comparison,
  mergeTimeline,
  personFigures,
  presenceItems,
  ranks,
  roleDesk,
  teamMedians,
} from './figures.js';
import { presenceTotals } from './presence.js';

const DAY_FROM = new Date('2026-11-09T18:00:00Z');
const DAY_TO = new Date('2026-11-10T18:00:00Z');
const hours = (h: number) => h * 3_600_000;

function online(activeHours: number) {
  return presenceTotals(
    activeHours === 0
      ? []
      : [
          {
            state: 'active',
            paused: false,
            startedAt: new Date('2026-11-10T03:00:00Z'),
            endedAt: new Date(Date.parse('2026-11-10T03:00:00Z') + hours(activeHours)),
          },
        ],
    DAY_FROM,
    DAY_TO,
  );
}

const agent = (userId: string, activeHours: number, confirmed: number, mistakes = 0) =>
  personFigures({
    userId,
    presence: online(activeHours),
    orders: { ...ZERO_ORDERS, confirmed, created: confirmed, piecesConfirmed: confirmed * 2 },
    mistakes,
  });

describe('personFigures', () => {
  it('counts actions, the mistake rate in tenths per 100 and the delivery rate', () => {
    const figures = personFigures({
      userId: 'u',
      presence: online(6),
      orders: {
        ...ZERO_ORDERS,
        created: 10,
        confirmed: 30,
        cancelled: 2,
        callAttempts: 40,
        confirmedDelivered: 18,
        confirmedReturned: 2,
      },
      packing: { ...ZERO_PACKING, packed: 0 },
      mistakes: 3,
    });
    expect(figures.actions).toBe(82);
    // 3 per 82 actions = 3.66 per 100: 37 tenths.
    expect(figures.mistakeRateTenths).toBe(37);
    expect(figures.deliveryRateBps).toBe(9000);
    expect(figures.desks).toEqual(['orders']);
  });

  it('has no rate with no actions', () => {
    const figures = personFigures({ userId: 'u', presence: online(0), mistakes: 0 });
    expect(figures.mistakeRateTenths).toBeNull();
    expect(figures.deliveryRateBps).toBeNull();
    expect(figures.desks).toEqual([]);
  });
});

describe('medians and ranks', () => {
  const people = [
    agent('a', 6, 30),
    agent('b', 4, 50, 5),
    agent('c', 8, 10),
    agent('absent', 0, 0),
  ];

  it('takes the median over people who worked only', () => {
    const medians = teamMedians(people);
    expect(medians.ordersConfirmed).toBe(30);
    expect(medians.activeMs).toBe(hours(6));
  });

  it('ranks highest first, and lowest first for the mistake rate, ties sharing', () => {
    const rankOf = ranks([...people, agent('d', 6, 30)]);
    expect(rankOf.get('b')?.ordersConfirmed).toBe(1);
    expect(rankOf.get('a')?.ordersConfirmed).toBe(2);
    expect(rankOf.get('d')?.ordersConfirmed).toBe(2);
    expect(rankOf.get('c')?.ordersConfirmed).toBe(4);
    expect(rankOf.get('a')?.mistakeRateTenths).toBe(1);
    expect(rankOf.get('b')?.mistakeRateTenths).toBe(4);
    expect(rankOf.get('absent')?.mistakeRateTenths).toBeNull();
  });
});

describe('the comparison table (check 7)', () => {
  const people = [agent('me', 6, 30), agent('b', 4, 50), agent('c', 8, 10)];
  const names = new Map([
    ['me', 'Rahim'],
    ['b', 'Karim'],
    ['c', 'Salma'],
  ]);

  it('names everyone when the brand shows names, ids only on the viewer’s row', () => {
    const { desk, rows } = comparison({
      people,
      names,
      viewerId: 'me',
      showNames: true,
      desk: null,
      fallbackDesk: null,
    });
    expect(desk).toBe('orders');
    expect(rows.map((r) => [r.name, r.isViewer, r.userId])).toEqual([
      ['Salma', false, null],
      ['Rahim', true, 'me'],
      ['Karim', false, null],
    ]);
  });

  it('hides colleagues’ names as “Colleague n” and keeps the viewer’s', () => {
    const { rows } = comparison({
      people,
      names,
      viewerId: 'me',
      showNames: false,
      desk: null,
      fallbackDesk: null,
    });
    expect(rows.map((r) => [r.name, r.colleagueNo, r.userId])).toEqual([
      [null, 1, null],
      ['Rahim', null, 'me'],
      [null, 2, null],
    ]);
    expect(JSON.stringify(rows)).not.toContain('Karim');
    expect(JSON.stringify(rows)).not.toContain('Salma');
  });

  it('keeps to the desk: a packer is not compared with the sales desk', () => {
    const packer = personFigures({
      userId: 'p',
      presence: online(7),
      packing: { ...ZERO_PACKING, packed: 40, piecesPacked: 90 },
      mistakes: 0,
    });
    const { rows } = comparison({
      people: [...people, packer],
      names,
      viewerId: 'me',
      showNames: true,
      desk: null,
      fallbackDesk: null,
    });
    expect(rows).toHaveLength(3);
  });

  it('with no desk at all, the viewer sees only their own row, never the brand', () => {
    const fresh = personFigures({ userId: 'new', presence: online(0), mistakes: 0 });
    const { desk, rows } = comparison({
      people: [...people, fresh],
      names,
      viewerId: 'new',
      showNames: true,
      desk: null,
      fallbackDesk: roleDesk(['marketing']),
    });
    expect(desk).toBeNull();
    expect(rows.map((row) => row.userId)).toEqual(['new']);
  });

  it('a viewer with nothing yet is compared on their role’s desk', () => {
    const fresh = personFigures({ userId: 'new', presence: online(0), mistakes: 0 });
    const { desk, rows } = comparison({
      people: [...people, fresh],
      names,
      viewerId: 'new',
      showNames: true,
      desk: null,
      fallbackDesk: roleDesk(['sales']),
    });
    expect(desk).toBe('orders');
    expect(rows.some((r) => r.isViewer)).toBe(true);
    expect(rows).toHaveLength(4);
  });
});

describe('the timeline', () => {
  const at = (hhmm: string) => new Date(`2026-11-10T${hhmm}:00+06:00`);
  it('marks coming online, a long idle stretch and an absence', () => {
    const items = presenceItems([
      { state: 'active', paused: false, startedAt: at('09:00'), endedAt: at('10:00') },
      { state: 'idle', paused: false, startedAt: at('10:00'), endedAt: at('10:20') },
      { state: 'active', paused: false, startedAt: at('10:20'), endedAt: at('10:21') },
      // Two minutes away: too short to show.
      { state: 'active', paused: false, startedAt: at('10:23'), endedAt: at('12:00') },
      { state: 'active', paused: false, startedAt: at('13:00'), endedAt: at('14:00') },
    ]);
    expect(items.map((i) => [i.kind, i.at.toISOString(), i.detail.minutes ?? null])).toEqual([
      ['presence.online', at('09:00').toISOString(), null],
      ['presence.idle', at('10:00').toISOString(), 20],
      ['presence.away', at('12:00').toISOString(), 60],
      ['presence.online', at('13:00').toISOString(), null],
    ]);
  });

  it('merges newest first, each id once, and says when it cut', () => {
    const item = (id: string, hhmm: string): TimelineItem => ({
      id,
      at: at(hhmm),
      desk: 'orders',
      kind: 'order.confirmed',
      ref: null,
      detail: {},
    });
    const merged = mergeTimeline(
      [
        [item('a', '09:00'), item('b', '11:00')],
        [item('c', '10:00'), item('a', '09:00')],
      ],
      2,
    );
    expect(merged.items.map((i) => i.id)).toEqual(['b', 'c']);
    expect(merged.truncated).toBe(true);
  });
});
