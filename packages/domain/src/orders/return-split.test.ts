import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { poisha } from '../money/index.js';
import {
  partialReturnAmounts,
  returnableQty,
  splitReturn,
  stillOutQty,
  type ReturnSplitLine,
} from './return-split.js';

/** D-1028 to D-1030: how a receipt splits per item, and what taking pieces back is worth. */

const line = (skuId: string, qty: number, deliveredQty = 0, returnedQty = 0): ReturnSplitLine => ({
  skuId,
  qty,
  deliveredQty,
  returnedQty,
});

describe('splitReturn', () => {
  it('a parcel on its way back: pieces from transit, the rest missing', () => {
    const split = splitReturn({
      lines: [line('a', 3), line('b', 1)],
      partlyDelivered: false,
      back: new Map([['a', 2]]),
    });
    expect(split).toEqual([
      { skuId: 'a', fromTransit: 2, fromDelivered: 0, missing: 1 },
      { skuId: 'b', fromTransit: 0, fromDelivered: 0, missing: 1 },
    ]);
  });

  it('a courier partial booked as all kept: what came back is taken off the delivered count', () => {
    const split = splitReturn({
      lines: [line('a', 2, 2), line('b', 1, 1)],
      partlyDelivered: true,
      back: new Map([['a', 1]]),
    });
    expect(split).toEqual([
      { skuId: 'a', fromTransit: 0, fromDelivered: 1, missing: 0 },
      { skuId: 'b', fromTransit: 0, fromDelivered: 0, missing: 0 },
    ]);
  });

  it('a partial a person recorded: the expected piece first, then the delivered ones', () => {
    const split = splitReturn({
      lines: [line('a', 3, 2)],
      partlyDelivered: true,
      back: new Map([['a', 2]]),
    });
    expect(split).toEqual([{ skuId: 'a', fromTransit: 1, fromDelivered: 1, missing: 0 }]);
  });

  it('refuses more back than may come back, and an item not on the order', () => {
    expect(() =>
      splitReturn({ lines: [line('a', 2, 1)], partlyDelivered: false, back: new Map([['a', 2]]) }),
    ).toThrow(/More pieces/);
    expect(() =>
      splitReturn({
        lines: [line('a', 2, 1, 1)],
        partlyDelivered: true,
        back: new Map([['a', 2]]),
      }),
    ).toThrow(/More pieces/);
    expect(() =>
      splitReturn({ lines: [line('a', 2)], partlyDelivered: false, back: new Map([['z', 1]]) }),
    ).toThrow(/not on this order/);
  });

  it('every piece is accounted for once, and the delivered count never goes below zero', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc
            .record({
              qty: fc.integer({ min: 0, max: 6 }),
              delivered: fc.integer({ min: 0, max: 6 }),
              returned: fc.integer({ min: 0, max: 6 }),
              back: fc.integer({ min: 0, max: 6 }),
            })
            .filter((entry) => entry.delivered + entry.returned <= entry.qty),
          { minLength: 1, maxLength: 5 },
        ),
        fc.boolean(),
        (raw, partly) => {
          const lines = raw.map((entry, index) =>
            line(`s${String(index)}`, entry.qty, entry.delivered, entry.returned),
          );
          const back = new Map(
            raw.map((entry, index) => [
              `s${String(index)}`,
              Math.min(entry.back, returnableQty(lines[index] ?? line('x', 0), partly)),
            ]),
          );
          const split = splitReturn({ lines, partlyDelivered: partly, back });
          return split.every((entry, index) => {
            const source = lines[index];
            if (source === undefined) return false;
            const got = back.get(entry.skuId) ?? 0;
            return (
              entry.fromTransit + entry.fromDelivered === got &&
              entry.fromTransit + entry.missing === stillOutQty(source) &&
              entry.fromDelivered <= source.deliveredQty &&
              (partly || entry.fromDelivered === 0) &&
              entry.missing >= 0
            );
          });
        },
      ),
    );
  });
});

describe('partialReturnAmounts', () => {
  it('worked example: Tk 650 × 2, one back, nothing prepaid', () => {
    const amounts = partialReturnAmounts({
      lines: [
        {
          qty: 2,
          unitPricePoisha: poisha(65_000n),
          lineDiscountPoisha: poisha(0n),
          deliveredBefore: 2,
          deliveredAfter: 1,
        },
      ],
      orderDiscountPoisha: poisha(0n),
      deliveryChargePoisha: poisha(13_000n),
      advancePoisha: poisha(0n),
    });
    expect(amounts).toEqual({
      netBeforePoisha: 130_000n,
      netAfterPoisha: 65_000n,
      advanceReleasedPoisha: 0n,
    });
  });

  it('worked example: an order discount follows the pieces kept, and an advance is released', () => {
    // Tk 1,000 + Tk 200 lines, Tk 120 off the order (apportioned 100 / 20 by net), delivery
    // Tk 100, Tk 800 prepaid. Kept only the Tk 200 line: Tk 180 net, Tk 280 payable, so Tk 280
    // of the advance applies where Tk 800 did; Tk 520 is the buyer's.
    const amounts = partialReturnAmounts({
      lines: [
        {
          qty: 1,
          unitPricePoisha: poisha(100_000n),
          lineDiscountPoisha: poisha(0n),
          deliveredBefore: 1,
          deliveredAfter: 0,
        },
        {
          qty: 1,
          unitPricePoisha: poisha(20_000n),
          lineDiscountPoisha: poisha(0n),
          deliveredBefore: 1,
          deliveredAfter: 1,
        },
      ],
      orderDiscountPoisha: poisha(12_000n),
      deliveryChargePoisha: poisha(10_000n),
      advancePoisha: poisha(80_000n),
    });
    expect(amounts).toEqual({
      netBeforePoisha: 108_000n,
      netAfterPoisha: 18_000n,
      advanceReleasedPoisha: 52_000n,
    });
  });

  it('nothing kept is worth nothing, and the delivered count only falls', () => {
    const amounts = partialReturnAmounts({
      lines: [
        {
          qty: 1,
          unitPricePoisha: poisha(65_000n),
          lineDiscountPoisha: poisha(0n),
          deliveredBefore: 1,
          deliveredAfter: 0,
        },
      ],
      orderDiscountPoisha: poisha(0n),
      deliveryChargePoisha: poisha(10_000n),
      advancePoisha: poisha(0n),
    });
    expect(amounts.netAfterPoisha).toBe(0n);
    expect(() =>
      partialReturnAmounts({
        lines: [
          {
            qty: 1,
            unitPricePoisha: poisha(1n),
            lineDiscountPoisha: poisha(0n),
            deliveredBefore: 0,
            deliveredAfter: 1,
          },
        ],
        orderDiscountPoisha: poisha(0n),
        deliveryChargePoisha: poisha(0n),
        advancePoisha: poisha(0n),
      }),
    ).toThrow(/only lower/);
  });
});
