import { nearestRank } from '../targets/productivity.js';

import {
  ZERO_CALLS,
  ZERO_INBOX,
  ZERO_ORDERS,
  ZERO_PACKING,
  ZERO_RETURNS,
  type CallCounts,
  type InboxCounts,
  type OrderCounts,
  type PackingCounts,
  type ReturnCounts,
  type StaffDesk,
  type TimelineItem,
} from './facts.js';
import type { PresenceSpan, PresenceTotals } from './presence.js';

/**
 * Each person's figures for a period, the team's medians, and the comparison table staff see
 * (M57, D-1000). Counts arrive from the modules; this only adds them up and compares.
 */

export interface PersonFigures {
  readonly userId: string;
  readonly presence: PresenceTotals;
  readonly orders: OrderCounts;
  readonly inbox: InboxCounts;
  readonly calls: CallCounts;
  readonly packing: PackingCounts;
  readonly returns: ReturnCounts;
  /** The actions a mistake rate is measured against (see `actionsOf`). */
  readonly actions: number;
  /** Mistakes that count (unreviewed and confirmed, D-1002). */
  readonly mistakes: number;
  /** Mistakes per 100 actions, in tenths (12 is 1.2 per 100); null with no actions. */
  readonly mistakeRateTenths: number | null;
  /** Delivered share of the orders they confirmed that have finished, basis points; or null. */
  readonly deliveryRateBps: number | null;
  /** The desks they worked at in the period, busiest first. */
  readonly desks: readonly StaffDesk[];
}

/**
 * The actions a person took: each a decision or a piece of work a mistake could be made in.
 * Pieces are not actions (a ten-piece order is one confirmation, one packing).
 */
export function actionsOf(parts: {
  readonly orders: OrderCounts;
  readonly inbox: InboxCounts;
  readonly calls: CallCounts;
  readonly packing: PackingCounts;
  readonly returns: ReturnCounts;
}): number {
  return (
    parts.orders.created +
    parts.orders.confirmed +
    parts.orders.cancelled +
    parts.orders.callAttempts +
    parts.orders.returnsRecorded +
    parts.inbox.messagesSent +
    parts.calls.outbound +
    parts.calls.answered +
    parts.packing.packed +
    // A return closed at the station books its receipt (M51), so the receipt alone counts.
    parts.returns.received
  );
}

function desksOf(parts: {
  readonly orders: OrderCounts;
  readonly inbox: InboxCounts;
  readonly calls: CallCounts;
  readonly packing: PackingCounts;
  readonly returns: ReturnCounts;
}): StaffDesk[] {
  const weights: [StaffDesk, number][] = [
    [
      'orders',
      parts.orders.created +
        parts.orders.taken +
        parts.orders.confirmed +
        parts.orders.cancelled +
        parts.orders.callAttempts,
    ],
    ['inbox', parts.inbox.messagesSent + parts.inbox.notes],
    ['calls', parts.calls.outbound + parts.calls.inbound],
    ['packing', parts.packing.packed + parts.packing.lotsClosed + parts.packing.handoverScans],
    [
      'returns',
      parts.returns.received + parts.orders.returnsRecorded + parts.packing.returnsClosed,
    ],
  ];
  return weights
    .filter(([, weight]) => weight > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([desk]) => desk);
}

export function personFigures(input: {
  readonly userId: string;
  readonly presence: PresenceTotals;
  readonly orders?: OrderCounts;
  readonly inbox?: InboxCounts;
  readonly calls?: CallCounts;
  readonly packing?: PackingCounts;
  readonly returns?: ReturnCounts;
  readonly mistakes: number;
}): PersonFigures {
  const parts = {
    orders: input.orders ?? ZERO_ORDERS,
    inbox: input.inbox ?? ZERO_INBOX,
    calls: input.calls ?? ZERO_CALLS,
    packing: input.packing ?? ZERO_PACKING,
    returns: input.returns ?? ZERO_RETURNS,
  };
  const actions = actionsOf(parts);
  const finished = parts.orders.confirmedDelivered + parts.orders.confirmedReturned;
  return {
    userId: input.userId,
    presence: input.presence,
    ...parts,
    actions,
    mistakes: input.mistakes,
    mistakeRateTenths: actions === 0 ? null : Math.round((input.mistakes * 1000) / actions),
    deliveryRateBps:
      finished === 0 ? null : Math.round((parts.orders.confirmedDelivered * 10_000) / finished),
    desks: desksOf(parts),
  };
}

/** The figures the team table and the comparison show, as plain numbers, by name. */
export const HEADLINE_FIGURES = [
  'activeMs',
  'onlineMs',
  'ordersConfirmed',
  'piecesConfirmed',
  'messagesSent',
  'calls',
  'talkSeconds',
  'packed',
  'piecesPacked',
  'returnsReceived',
  'returnsClosed',
  'mistakeRateTenths',
] as const;
export type HeadlineFigure = (typeof HEADLINE_FIGURES)[number];

/** Lower is better for these; higher for the rest. */
const LOWER_IS_BETTER: ReadonlySet<HeadlineFigure> = new Set(['mistakeRateTenths']);

export function headline(figures: PersonFigures): Record<HeadlineFigure, number | null> {
  return {
    activeMs: figures.presence.activeMs,
    onlineMs: figures.presence.onlineMs,
    ordersConfirmed: figures.orders.confirmed,
    piecesConfirmed: figures.orders.piecesConfirmed,
    messagesSent: figures.inbox.messagesSent,
    calls: figures.calls.outbound + figures.calls.answered,
    talkSeconds: figures.calls.talkSeconds,
    packed: figures.packing.packed,
    piecesPacked: figures.packing.piecesPacked,
    returnsReceived: figures.returns.received,
    returnsClosed: figures.packing.returnsClosed,
    mistakeRateTenths: figures.mistakeRateTenths,
  };
}

/** Whether a person did anything at all in the period: the median ignores the absent. */
export function worked(figures: PersonFigures): boolean {
  return figures.actions > 0 || figures.presence.onlineMs > 0;
}

/** The team's median (nearest rank, as D-276) of each headline figure, over people who worked. */
export function teamMedians(
  people: readonly PersonFigures[],
): Record<HeadlineFigure, number | null> {
  const present = people.filter(worked).map(headline);
  const result = {} as Record<HeadlineFigure, number | null>;
  for (const figure of HEADLINE_FIGURES) {
    const values = present
      .map((row) => row[figure])
      .filter((value): value is number => value !== null)
      .sort((a, b) => a - b);
    result[figure] = nearestRank(values, 50);
  }
  return result;
}

/**
 * Standard competition ranks ("1, 2, 2, 4") of each headline figure among `people`; a null
 * figure (a rate with no actions) has no rank.
 */
export function ranks(
  people: readonly PersonFigures[],
): Map<string, Record<HeadlineFigure, number | null>> {
  const rows = people.map((person) => ({ userId: person.userId, values: headline(person) }));
  const result = new Map<string, Record<HeadlineFigure, number | null>>();
  for (const row of rows) result.set(row.userId, {} as Record<HeadlineFigure, number | null>);
  for (const figure of HEADLINE_FIGURES) {
    const lowerBetter = LOWER_IS_BETTER.has(figure);
    for (const row of rows) {
      const mine = row.values[figure];
      const out = result.get(row.userId);
      if (out === undefined) continue;
      if (mine === null) {
        out[figure] = null;
        continue;
      }
      const better = rows.filter((other) => {
        const theirs = other.values[figure];
        if (theirs === null) return false;
        return lowerBetter ? theirs < mine : theirs > mine;
      }).length;
      out[figure] = better + 1;
    }
  }
  return result;
}

export interface ComparisonRow {
  /** The person's name, or "Colleague n" (`label` null, `colleagueNo` set) when names are hidden. */
  readonly name: string | null;
  readonly colleagueNo: number | null;
  readonly isViewer: boolean;
  /** The viewer's own row carries the id; every row does for a reader who sees everyone. */
  readonly userId: string | null;
  readonly figures: Record<HeadlineFigure, number | null>;
  readonly ranks: Record<HeadlineFigure, number | null>;
}

/**
 * The comparison table (D-1000): the people who share the viewer's main desk, headline figures
 * and ranks only. With names hidden, colleagues are numbered by their place in active time (so
 * the numbering follows the table, not the alphabet) and carry no id.
 */
export function comparison(input: {
  readonly people: readonly PersonFigures[];
  readonly names: ReadonlyMap<string, string>;
  readonly viewerId: string;
  readonly showNames: boolean;
  /** A supervisor reading someone's page (`read StaffActivity` at `org`) learns each row's id. */
  readonly revealIds?: boolean;
  /** The desk to compare on; null for the viewer's own busiest desk. */
  readonly desk: StaffDesk | null;
  /** The viewer's role's desk, for a viewer who did nothing yet in the period. */
  readonly fallbackDesk: StaffDesk | null;
}): { readonly desk: StaffDesk | null; readonly rows: ComparisonRow[] } {
  const viewer = input.people.find((person) => person.userId === input.viewerId);
  const desk = input.desk ?? viewer?.desks[0] ?? input.fallbackDesk;
  // No desk (a role with none, nothing done yet): the viewer alone, never the whole brand.
  const peers = input.people.filter(
    (person) =>
      person.userId === input.viewerId ||
      (desk !== null && worked(person) && person.desks.includes(desk)),
  );
  const rankOf = ranks(peers);
  const ordered = [...peers].sort(
    (a, b) =>
      b.presence.activeMs - a.presence.activeMs ||
      b.actions - a.actions ||
      a.userId.localeCompare(b.userId),
  );
  let colleague = 0;
  const rows = ordered.map((person): ComparisonRow => {
    const isViewer = person.userId === input.viewerId;
    const named = isViewer || input.showNames;
    if (!named) colleague += 1;
    return {
      name: named ? (input.names.get(person.userId) ?? null) : null,
      colleagueNo: named ? null : colleague,
      isViewer,
      userId: isViewer || input.revealIds === true ? person.userId : null,
      figures: headline(person),
      ranks: rankOf.get(person.userId) ?? ({} as Record<HeadlineFigure, number | null>),
    };
  });
  return { desk, rows };
}

/** The desk a role works at, for someone with nothing in the period yet. */
export function roleDesk(roles: readonly string[]): StaffDesk | null {
  if (roles.includes('sales')) return 'orders';
  if (roles.includes('warehouse')) return 'packing';
  if (roles.includes('branch_manager')) return 'returns';
  return null;
}

// --- the timeline ------------------------------------------------------------------------

/** Idle stretches and absences shorter than this are left out of the timeline. */
export const TIMELINE_GAP_MS = 5 * 60_000;

/**
 * The presence lines of a timeline: when the person came online (after an absence), went away
 * (for longer than {@link TIMELINE_GAP_MS}), and stretches idle that long.
 */
export function presenceItems(spans: readonly PresenceSpan[]): TimelineItem[] {
  const sorted = [...spans].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  const items: TimelineItem[] = [];
  let previousEnd: number | null = null;
  for (const span of sorted) {
    const start = span.startedAt.getTime();
    const awayMs = previousEnd === null ? null : start - previousEnd;
    if (awayMs !== null && previousEnd !== null && awayMs >= TIMELINE_GAP_MS) {
      items.push({
        id: `presence:away:${String(previousEnd)}`,
        at: new Date(previousEnd),
        desk: 'presence',
        kind: 'presence.away',
        ref: null,
        detail: { minutes: Math.floor(awayMs / 60_000) },
      });
    }
    if (awayMs === null || awayMs >= TIMELINE_GAP_MS) {
      items.push({
        id: `presence:online:${String(start)}`,
        at: span.startedAt,
        desk: 'presence',
        kind: 'presence.online',
        ref: null,
        detail: {},
      });
    }
    const length = span.endedAt.getTime() - start;
    if (span.state === 'idle' && length >= TIMELINE_GAP_MS) {
      items.push({
        id: `presence:idle:${String(start)}`,
        at: span.startedAt,
        desk: 'presence',
        kind: 'presence.idle',
        ref: null,
        detail: { minutes: Math.floor(length / 60_000) },
      });
    }
    previousEnd = Math.max(previousEnd ?? 0, span.endedAt.getTime());
  }
  return items;
}

/** The modules' items and the presence lines, newest first, each id once. */
export function mergeTimeline(
  parts: readonly (readonly TimelineItem[])[],
  limit: number,
): { readonly items: TimelineItem[]; readonly truncated: boolean } {
  const seen = new Set<string>();
  const all: TimelineItem[] = [];
  for (const part of parts) {
    for (const item of part) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      all.push(item);
    }
  }
  all.sort((a, b) => b.at.getTime() - a.at.getTime() || a.id.localeCompare(b.id));
  return { items: all.slice(0, limit), truncated: all.length > limit };
}
