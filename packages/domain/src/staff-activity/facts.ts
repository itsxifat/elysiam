/**
 * What each module hands the staff-activity module (M57, D-1006): per-person counts for a period,
 * the narrow candidate rows the mistake rules decide on, and one person's timeline items.
 *
 * The owning module's SQL only gathers; every decision (is this a mistake, whose, how bad) is a
 * pure function in this package (invariant 11). A candidate query may pre-filter by a threshold
 * it is passed, so a month of a busy brand's messages is never shipped to be thrown away, but it
 * never decides attribution.
 */

/** A staff-activity period: `[from, to)` on the instant. */
export interface StaffPeriod {
  readonly from: Date;
  readonly to: Date;
}

/** The desks a person's work falls under. */
export const STAFF_DESKS = ['orders', 'inbox', 'calls', 'packing', 'returns'] as const;
export type StaffDesk = (typeof STAFF_DESKS)[number];

/** The orders module's counts for one person (D-276's actor, `sales.order_events`). */
export interface OrderCounts {
  readonly created: number;
  /** Claimed from the queue, accepted from an offer, or handed to them. */
  readonly taken: number;
  readonly confirmed: number;
  readonly cancelled: number;
  /** Pieces on the orders they confirmed. */
  readonly piecesConfirmed: number;
  /** Net items of the orders they confirmed, poisha (the selling price; no cost, invariant 5). */
  readonly valueConfirmedPoisha: bigint;
  /** Of the orders they confirmed in the period: delivered (fully or partly) and returned. */
  readonly confirmedDelivered: number;
  readonly confirmedReturned: number;
  readonly callAttempts: number;
  readonly callsReached: number;
  readonly offersAccepted: number;
  readonly offersDeclined: number;
  readonly offersExpired: number;
  /** Returns and exchanges they recorded on an order. */
  readonly returnsRecorded: number;
}

export interface InboxCounts {
  readonly messagesSent: number;
  /** Conversations they sent at least one message in. */
  readonly conversations: number;
  readonly notes: number;
  /** Waits they ended with a reply, and the median of those waits (nearest rank). */
  readonly firstReplies: number;
  readonly medianFirstReplySeconds: number | null;
}

export interface CallCounts {
  readonly outbound: number;
  readonly inbound: number;
  readonly answered: number;
  /** Inbound calls to their extension nobody answered. */
  readonly missed: number;
  readonly talkSeconds: number;
  readonly wrappedUp: number;
}

export interface PackingCounts {
  /** Packing sessions they completed. */
  readonly packed: number;
  /** Pieces they scanned in (accepted scans less their removals). */
  readonly piecesPacked: number;
  readonly medianPackSeconds: number | null;
  /** Scans the station refused as the wrong item, the wrong size or colour, or one too many. */
  readonly wrongScans: number;
  readonly lotsClosed: number;
  readonly handoverScans: number;
  readonly labelsPrinted: number;
  readonly reprints: number;
  /** Return-station sessions they completed (M51), and the pieces they checked back in. */
  readonly returnsClosed: number;
  readonly piecesReturned: number;
}

export interface ReturnCounts {
  /** Courier returns they received at the return station or counter. */
  readonly received: number;
  readonly piecesReceived: number;
  readonly damagedPieces: number;
}

export const ZERO_ORDERS: OrderCounts = {
  created: 0,
  taken: 0,
  confirmed: 0,
  cancelled: 0,
  piecesConfirmed: 0,
  valueConfirmedPoisha: 0n,
  confirmedDelivered: 0,
  confirmedReturned: 0,
  callAttempts: 0,
  callsReached: 0,
  offersAccepted: 0,
  offersDeclined: 0,
  offersExpired: 0,
  returnsRecorded: 0,
};

export const ZERO_INBOX: InboxCounts = {
  messagesSent: 0,
  conversations: 0,
  notes: 0,
  firstReplies: 0,
  medianFirstReplySeconds: null,
};

export const ZERO_CALLS: CallCounts = {
  outbound: 0,
  inbound: 0,
  answered: 0,
  missed: 0,
  talkSeconds: 0,
  wrappedUp: 0,
};

export const ZERO_PACKING: PackingCounts = {
  packed: 0,
  piecesPacked: 0,
  medianPackSeconds: null,
  wrongScans: 0,
  lotsClosed: 0,
  handoverScans: 0,
  labelsPrinted: 0,
  reprints: 0,
  returnsClosed: 0,
  piecesReturned: 0,
};

export const ZERO_RETURNS: ReturnCounts = { received: 0, piecesReceived: 0, damagedPieces: 0 };

/** What a mistake or a timeline item points at; the console turns it into a link. */
export interface StaffRef {
  readonly type: 'order' | 'conversation' | 'call' | 'packing_session';
  readonly id: string;
  /** An order number, or nothing a staff member may not see (never a phone or a name). */
  readonly label: string | null;
}

// --- mistake candidates ------------------------------------------------------------------

export interface WrongScanFact {
  readonly scanId: string;
  readonly sessionId: string;
  readonly orderId: string;
  readonly orderNo: string;
  readonly scannedBy: string;
  readonly at: Date;
  readonly outcome: 'wrong_item' | 'wrong_variant' | 'over';
}

/** A return or exchange recorded on an order, with what the orders module knows of it. */
export interface ReturnFact {
  readonly returnId: string;
  readonly orderId: string;
  readonly orderNo: string;
  readonly reasonCode: string;
  readonly at: Date;
  /** Who confirmed the order; null for one confirmed by the system or never confirmed. */
  readonly confirmedBy: string | null;
  /** Call attempts on the order before it was confirmed that reached the customer. */
  readonly reachedBeforeConfirm: number;
}

/** Who completed an order's packing last, from the packing module. */
export interface PackerFact {
  readonly orderId: string;
  readonly sessionId: string;
  readonly completedBy: string;
  readonly completedAt: Date;
}

export interface ConfirmationFact {
  readonly orderId: string;
  readonly orderNo: string;
  readonly confirmedBy: string;
  readonly confirmedAt: Date;
  /** Call attempts logged on the order before it was confirmed (M41), any outcome. */
  readonly attemptsBeforeConfirm: number;
  /** The order's channel; a till sale never comes here. */
  readonly channel: string;
}

export interface CancelAfterConfirmFact {
  readonly orderId: string;
  readonly orderNo: string;
  readonly confirmedBy: string;
  readonly cancelledAt: Date;
  readonly cancelledBy: string | null;
}

export interface CallBackFact {
  readonly attemptId: string;
  readonly orderId: string;
  readonly orderNo: string;
  /** Who set the call-back time. */
  readonly setBy: string;
  readonly callBackAt: Date;
  /** The next attempt on the order after this one, by anybody, or null. */
  readonly nextAttemptAt: Date | null;
  /** The order left the desk (confirmed or cancelled) before the call-back fell due. */
  readonly settledAt: Date | null;
}

/** A customer waiting for a reply: an inbound message after the last outbound one. */
export interface WaitFact {
  readonly conversationId: string;
  readonly messageId: string;
  readonly inboundAt: Date;
  /** The conversation's holder now, and since when; null if nobody holds it. */
  readonly holder: string | null;
  readonly heldSince: Date | null;
  readonly repliedAt: Date | null;
  readonly repliedBy: string | null;
}

export interface MissedCallFact {
  readonly callId: string;
  readonly userId: string;
  readonly at: Date;
}

export interface UnwrappedCallFact {
  readonly callId: string;
  readonly userId: string;
  readonly endedAt: Date;
  readonly wrappedUpAt: Date | null;
}

export interface ExpiredOfferFact {
  readonly offerId: string;
  readonly ref: StaffRef;
  readonly userId: string;
  readonly expiredAt: Date;
}

export interface NoVideoFact {
  readonly sessionId: string;
  readonly orderId: string;
  readonly orderNo: string;
  readonly completedBy: string;
  readonly completedAt: Date;
}

export interface MistakeFacts {
  readonly wrongScans: readonly WrongScanFact[];
  readonly returns: readonly ReturnFact[];
  readonly packers: readonly PackerFact[];
  readonly confirmations: readonly ConfirmationFact[];
  /** Order ids, of `confirmations`, with an Envo call linked to them before confirming. */
  readonly phonedOrders: ReadonlySet<string>;
  readonly cancelsAfterConfirm: readonly CancelAfterConfirmFact[];
  readonly callBacks: readonly CallBackFact[];
  readonly waits: readonly WaitFact[];
  readonly missedCalls: readonly MissedCallFact[];
  readonly unwrappedCalls: readonly UnwrappedCallFact[];
  readonly expiredOffers: readonly ExpiredOfferFact[];
  readonly noVideo: readonly NoVideoFact[];
}

export const NO_MISTAKE_FACTS: MistakeFacts = {
  wrongScans: [],
  returns: [],
  packers: [],
  confirmations: [],
  phonedOrders: new Set(),
  cancelsAfterConfirm: [],
  callBacks: [],
  waits: [],
  missedCalls: [],
  unwrappedCalls: [],
  expiredOffers: [],
  noVideo: [],
};

// --- the timeline ------------------------------------------------------------------------

/** One thing a person did, as a module tells it. No message body, phone number or cost. */
export interface TimelineItem {
  /** Unique within the timeline: `<module>:<kind>:<id>`. */
  readonly id: string;
  readonly at: Date;
  /** The desk it was done at, or `presence` for the online, idle and away lines. */
  readonly desk: StaffDesk | 'presence';
  /** A word the console translates: `order.confirmed`, `call.outbound`, `packing.completed`… */
  readonly kind: string;
  readonly ref: StaffRef | null;
  /** Small, safe facts for the line: pieces, seconds, an outcome code. */
  readonly detail: Readonly<Record<string, string | number>>;
}
