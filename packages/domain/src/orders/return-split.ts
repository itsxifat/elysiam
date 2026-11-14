import { sub, ZERO, type Poisha } from '../money/index.js';
import { OrderError } from './state.js';
import { applicableAdvance, computePartialDelivery } from './totals.js';

/**
 * What a returned parcel's receipt does to each item of its order (D-1028, D-1029).
 *
 * An order line has three counts: what went out (`qty`), what the buyer kept (`deliveredQty`)
 * and what came back (`returnedQty`). What is still with the courier is the rest. A receipt says
 * how many of each item came back, and each of those pieces is one of two kinds:
 *
 * - **from transit**: one of the pieces still with the courier. Stock back at the dispatch cost,
 *   `Dr Inventory / Cr Goods in transit` (§7's return).
 * - **from delivered**: a piece the order had counted as kept. Only a partly delivered order has
 *   these, and only because a courier's "partially delivered" names money and never pieces: the
 *   delivery was booked as every piece kept with the collection short (`deliveredLinesFor`), so
 *   the pieces that really came back were stranded, with no way into stock. Such a piece is no
 *   longer delivered: its sale is taken back (`orderPartialReturnDraft`).
 *
 * And a piece still with the courier that is not in the parcel is **missing**: the receipt says
 * it did not come back, and its value is claimed from the courier (`returnShortDraft`, D-1030).
 *
 * Pieces come back from transit first: a piece the order already expects back is that piece, and
 * only what is over it reaches into the delivered count.
 */

export interface ReturnSplitLine {
  readonly skuId: string;
  readonly qty: number;
  readonly deliveredQty: number;
  readonly returnedQty: number;
}

export interface ReturnSplit {
  readonly skuId: string;
  /** Back, out of the pieces still with the courier. */
  readonly fromTransit: number;
  /** Back, out of the pieces the order counted as delivered (a partly delivered order only). */
  readonly fromDelivered: number;
  /** Still with the courier and not in the parcel. */
  readonly missing: number;
}

function assertCounts(line: ReturnSplitLine): void {
  for (const value of [line.qty, line.deliveredQty, line.returnedQty]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new OrderError('ORDER_LINES_INVALID', 'An order line counts whole pieces.');
    }
  }
  if (line.deliveredQty + line.returnedQty > line.qty) {
    throw new OrderError(
      'ORDER_LINES_INVALID',
      'An order line has more pieces delivered and returned than went out.',
    );
  }
}

/** The pieces of a line still with the courier: what went out, less kept and returned. */
export function stillOutQty(line: ReturnSplitLine): number {
  assertCounts(line);
  return line.qty - line.deliveredQty - line.returnedQty;
}

/**
 * How many pieces of a line may come back. On a partly delivered order that includes the pieces
 * counted as delivered, since which ones the buyer kept is known only when the parcel is opened.
 */
export function returnableQty(line: ReturnSplitLine, partlyDelivered: boolean): number {
  assertCounts(line);
  return partlyDelivered
    ? line.qty - line.returnedQty
    : line.qty - line.deliveredQty - line.returnedQty;
}

/**
 * Split a receipt (`back`, pieces per SKU) across each line. Refuses a SKU that is not on the
 * order and more back than may come back: a piece out of nowhere would put stock on a shelf no
 * dispatch took it from.
 */
export function splitReturn(input: {
  readonly lines: readonly ReturnSplitLine[];
  readonly partlyDelivered: boolean;
  readonly back: ReadonlyMap<string, number>;
}): ReturnSplit[] {
  const known = new Set(input.lines.map((line) => line.skuId));
  for (const [skuId, qty] of input.back) {
    if (!known.has(skuId)) {
      throw new OrderError('ORDER_LINES_INVALID', 'One of those items is not on this order.');
    }
    if (!Number.isSafeInteger(qty) || qty < 0) {
      throw new OrderError('ORDER_LINES_INVALID', 'A return counts whole pieces.');
    }
  }
  return input.lines.map((line) => {
    const out = stillOutQty(line);
    const got = input.back.get(line.skuId) ?? 0;
    if (got > returnableQty(line, input.partlyDelivered)) {
      throw new OrderError(
        'ORDER_LINES_INVALID',
        'More pieces came back for one item than may come back on this order.',
      );
    }
    const fromTransit = Math.min(got, out);
    return {
      skuId: line.skuId,
      fromTransit,
      fromDelivered: got - fromTransit,
      missing: out - fromTransit,
    };
  });
}

/** A line as the correction prices it: its terms, and how many were delivered before and after. */
export interface PartialReturnLine {
  readonly qty: number;
  readonly unitPricePoisha: Poisha;
  readonly lineDiscountPoisha: Poisha;
  readonly deliveredBefore: number;
  readonly deliveredAfter: number;
}

export interface PartialReturnAmounts {
  /** Net item value the delivery recognised. */
  readonly netBeforePoisha: Poisha;
  /** Net item value of what the buyer really kept. */
  readonly netAfterPoisha: Poisha;
  /** Advance the delivery applied that the smaller delivery no longer can: owed to the buyer. */
  readonly advanceReleasedPoisha: Poisha;
}

/** Net item value of a delivered set, by the delivery journal's own rule; nothing kept is zero. */
function deliveredNet(
  lines: readonly PartialReturnLine[],
  pick: (line: PartialReturnLine) => number,
  orderDiscountPoisha: Poisha,
  deliveryChargePoisha: Poisha,
): Poisha {
  if (!lines.some((line) => pick(line) > 0)) return ZERO;
  return computePartialDelivery({
    lines: lines.map((line) => ({
      qty: line.qty,
      unitPricePoisha: line.unitPricePoisha,
      lineDiscountPoisha: line.lineDiscountPoisha,
      deliveredQty: pick(line),
    })),
    orderDiscountPoisha,
    deliveryChargePoisha,
  }).deliveredNetItemsPoisha;
}

/**
 * What taking pieces back off a partly delivered order is worth (D-1028): the net value the
 * delivery recognised and the net value of what the buyer kept, both through
 * `computePartialDelivery` as the delivery journal priced them, and the advance that no longer
 * applies, both through `applicableAdvance` as the delivery applied it.
 */
export function partialReturnAmounts(input: {
  readonly lines: readonly PartialReturnLine[];
  readonly orderDiscountPoisha: Poisha;
  readonly deliveryChargePoisha: Poisha;
  /** The order's advance column: verified advances and any exchange credit. */
  readonly advancePoisha: Poisha;
}): PartialReturnAmounts {
  for (const line of input.lines) {
    for (const value of [line.qty, line.deliveredBefore, line.deliveredAfter]) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new OrderError('ORDER_LINES_INVALID', 'An order line counts whole pieces.');
      }
    }
    if (line.deliveredAfter > line.deliveredBefore || line.deliveredBefore > line.qty) {
      throw new OrderError(
        'ORDER_LINES_INVALID',
        'Taking pieces back can only lower what was delivered.',
      );
    }
  }
  const netBeforePoisha = deliveredNet(
    input.lines,
    (line) => line.deliveredBefore,
    input.orderDiscountPoisha,
    input.deliveryChargePoisha,
  );
  const netAfterPoisha = deliveredNet(
    input.lines,
    (line) => line.deliveredAfter,
    input.orderDiscountPoisha,
    input.deliveryChargePoisha,
  );
  const applied = (net: Poisha) =>
    applicableAdvance({
      netItemsPoisha: net,
      deliveryChargePoisha: input.deliveryChargePoisha,
      creditPoisha: input.advancePoisha,
    }).appliedPoisha;
  const before = applied(netBeforePoisha);
  const after = applied(netAfterPoisha);
  return {
    netBeforePoisha,
    netAfterPoisha,
    advanceReleasedPoisha: before > after ? sub(before, after) : ZERO,
  };
}
