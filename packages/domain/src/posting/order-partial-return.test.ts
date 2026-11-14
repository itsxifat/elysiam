import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { validateJournalDraft, type JournalDraft } from '../ledger/index.js';
import { poisha, type Poisha } from '../money/index.js';
import { applicableAdvance } from '../orders/totals.js';
import { partialReturnAmounts } from '../orders/return-split.js';
import { orderDeliveredDraft } from './order-delivered.js';
import { orderPartialReturnDraft, returnShortDraft } from './order-partial-return.js';
import type { PostingAccount } from './supply-received.js';

/**
 * D-1028 and D-1030's journals: each balances for random inputs (fast-check), each has a worked
 * example, and the correction is proved against the books it corrects: the delivery booked as
 * every piece kept, plus this journal, leaves every account where the delivery of the true
 * pieces, plus their return, would have.
 */

const ORDER_ID = '7f1a2b3c-4d5e-6f70-8192-a3b4c5d6e7f9';
const COURIER_ID = '11111111-2222-3333-4444-555555555556';
const AT = new Date('2026-11-14T06:00:00Z');

let nextAccount = 0;
const accountIds = new Map<string, string>();
function accountIdFor(subtype: string): string {
  const existing = accountIds.get(subtype);
  if (existing !== undefined) return existing;
  nextAccount += 1;
  const id = `bbbbbbbb-0000-4000-8000-${String(nextAccount).padStart(12, '0')}`;
  accountIds.set(subtype, id);
  return id;
}
const account = (subtype: PostingAccount['subtype']): PostingAccount => ({
  accountId: accountIdFor(subtype),
  subtype,
  branchId: null,
});

const A = {
  courierReceivable: account('courier_receivable'),
  salesRevenue: account('sales_revenue'),
  deliveryIncome: account('delivery_charge_income'),
  cogs: account('cogs'),
  goodsInTransit: account('goods_in_transit'),
  inventory: account('inventory'),
  customerAdvance: account('customer_advance'),
  salesDiscounts: account('sales_discounts'),
  otherPayable: account('other_payable'),
  otherReceivable: account('other_receivable'),
};

/** Debits less credits on one account, across drafts. */
function net(drafts: readonly JournalDraft[], subtype: string): bigint {
  const id = accountIdFor(subtype);
  let total = 0n;
  for (const draft of drafts) {
    for (const line of draft.lines) {
      if (line.accountId === id) total += BigInt(line.debitPoisha) - BigInt(line.creditPoisha);
    }
  }
  return total;
}

function balanced(draft: JournalDraft): boolean {
  const debit = draft.lines.reduce((sum, line) => sum + BigInt(line.debitPoisha), 0n);
  const credit = draft.lines.reduce((sum, line) => sum + BigInt(line.creditPoisha), 0n);
  return debit === credit && debit > 0n;
}

const correction = (input: {
  before: bigint;
  after: bigint;
  released?: bigint;
  cost: bigint;
}): JournalDraft =>
  orderPartialReturnDraft({
    orderId: ORDER_ID,
    occurredAt: AT,
    salesRevenue: A.salesRevenue,
    salesDiscounts: A.salesDiscounts,
    inventory: A.inventory,
    cogs: A.cogs,
    otherPayable: A.otherPayable,
    netBeforePoisha: poisha(input.before),
    netAfterPoisha: poisha(input.after),
    advanceReleasedPoisha: poisha(input.released ?? 0n),
    costPoisha: poisha(input.cost),
    branchId: null,
    memo: 'Order ELY-2611-00130 pieces back',
  });

describe('orderPartialReturnDraft (D-1028)', () => {
  it('worked example: two kurtis out, the courier said partly delivered, one came back', () => {
    // Tk 650 × 2, delivery Tk 130, collected Tk 780 (one kept + delivery). Booked as both kept:
    // revenue 1,300, delivery 130, collected 780, Sales discounts 650 short. One came back.
    const draft = correction({ before: 130_000n, after: 65_000n, cost: 32_000n });
    validateJournalDraft(draft);
    expect(draft.idempotencyKey).toBe(`order:${ORDER_ID}:partial_returned`);
    expect(draft.businessDate).toBe('2026-11-14');
    expect(net([draft], 'sales_revenue')).toBe(65_000n);
    expect(net([draft], 'sales_discounts')).toBe(-65_000n);
    expect(net([draft], 'inventory')).toBe(32_000n);
    expect(net([draft], 'cogs')).toBe(-32_000n);
    // The rider's cash did not change: the courier's balance is not this journal's.
    expect(net([draft], 'courier_receivable')).toBe(0n);
    expect(net([draft], 'other_payable')).toBe(0n);
  });

  it('owes the buyer an advance that no longer applies, in Other payables', () => {
    // Tk 1,000 prepaid on a Tk 1,200 order with Tk 100 delivery; they kept Tk 400 of it, so
    // only Tk 500 of the advance applies now and Tk 500 is theirs.
    const draft = correction({ before: 120_000n, after: 40_000n, released: 50_000n, cost: 0n });
    validateJournalDraft(draft);
    expect(net([draft], 'sales_revenue')).toBe(80_000n);
    expect(net([draft], 'other_payable')).toBe(-50_000n);
    expect(net([draft], 'sales_discounts')).toBe(-30_000n);
  });

  it('takes the side a poisha of rounding gives, and refuses a journal of nothing', () => {
    const draft = correction({ before: 10_000n, after: 10_001n, cost: 5_000n });
    validateJournalDraft(draft);
    expect(net([draft], 'sales_revenue')).toBe(-1n);
    expect(net([draft], 'sales_discounts')).toBe(1n);
    expect(() => correction({ before: 5n, after: 5n, cost: 0n })).toThrow(/no value/);
    expect(() => correction({ before: 5n, after: 0n, released: 1n, cost: 0n })).not.toThrow();
    expect(() =>
      orderPartialReturnDraft({
        orderId: ORDER_ID,
        occurredAt: AT,
        salesRevenue: A.salesRevenue,
        salesDiscounts: A.salesDiscounts,
        inventory: A.inventory,
        cogs: A.cogs,
        netBeforePoisha: poisha(5n),
        netAfterPoisha: poisha(0n),
        advanceReleasedPoisha: poisha(1n),
        costPoisha: poisha(0n),
        branchId: null,
        memo: null,
      }),
    ).toThrow(/Other payables/);
  });

  it('balances for any amounts', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10_000_000n }),
        fc.bigInt({ min: 0n, max: 10_000_000n }),
        fc.bigInt({ min: 0n, max: 10_000_000n }),
        fc.bigInt({ min: 0n, max: 10_000_000n }),
        (before, after, released, cost) => {
          fc.pre(before !== after || released > 0n || cost > 0n);
          const draft = correction({ before, after, released, cost });
          validateJournalDraft(draft);
          return balanced(draft);
        },
      ),
    );
  });

  /*
   * The proof that matters. A random order, delivered (as a courier's partial books it) with every
   * piece kept and some collection, then some pieces back. "Booked + correction" must equal
   * "the true delivery + the return of the pieces that came back", account by account. Customer
   * advance and Other payables are compared together (both are the buyer's money), and Inventory
   * with Goods in transit (where the returned pieces' value sits between the two journals).
   */
  it('leaves every account where the true delivery and the return would', () => {
    const line = fc
      .record({
        qty: fc.integer({ min: 1, max: 4 }),
        unit: fc.bigInt({ min: 1n, max: 300_000n }),
        cost: fc.bigInt({ min: 0n, max: 300_000n }),
        discountShare: fc.integer({ min: 0, max: 100 }),
        backShare: fc.integer({ min: 0, max: 100 }),
      })
      .map((raw) => {
        const gross = raw.unit * BigInt(raw.qty);
        return {
          qty: raw.qty,
          unitPricePoisha: poisha(raw.unit),
          lineDiscountPoisha: poisha((gross * BigInt(raw.discountShare)) / 400n),
          unitCost: raw.cost,
          back: Math.floor((raw.qty * raw.backShare) / 100),
        };
      });
    fc.assert(
      fc.property(
        fc.array(line, { minLength: 1, maxLength: 4 }),
        fc.integer({ min: 0, max: 100 }),
        fc.bigInt({ min: 0n, max: 20_000n }),
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 0, max: 120 }),
        (lines, orderDiscountShare, delivery, advanceShare, collectShare) => {
          fc.pre(lines.some((entry) => entry.back > 0));
          const netLines = lines.reduce(
            (sum, entry) =>
              sum +
              BigInt(entry.unitPricePoisha) * BigInt(entry.qty) -
              BigInt(entry.lineDiscountPoisha),
            0n,
          );
          const orderDiscount = poisha((netLines * BigInt(orderDiscountShare)) / 200n);
          const advance = poisha(((netLines + delivery) * BigInt(advanceShare)) / 100n);
          const amounts = partialReturnAmounts({
            lines: lines.map((entry) => ({
              qty: entry.qty,
              unitPricePoisha: entry.unitPricePoisha,
              lineDiscountPoisha: entry.lineDiscountPoisha,
              deliveredBefore: entry.qty,
              deliveredAfter: entry.qty - entry.back,
            })),
            orderDiscountPoisha: orderDiscount,
            deliveryChargePoisha: poisha(delivery),
            advancePoisha: advance,
          });
          fc.pre(BigInt(amounts.netAfterPoisha) + delivery > 0n);
          const cost = (pick: (entry: (typeof lines)[number]) => number): Poisha =>
            poisha(lines.reduce((sum, entry) => sum + entry.unitCost * BigInt(pick(entry)), 0n));
          const appliedBefore = applicableAdvance({
            netItemsPoisha: amounts.netBeforePoisha,
            deliveryChargePoisha: poisha(delivery),
            creditPoisha: advance,
          }).appliedPoisha;
          const appliedAfter = applicableAdvance({
            netItemsPoisha: amounts.netAfterPoisha,
            deliveryChargePoisha: poisha(delivery),
            creditPoisha: advance,
          }).appliedPoisha;
          // What the rider collected: anything up to a little over the smaller delivery.
          const collected = poisha(
            ((BigInt(amounts.netAfterPoisha) + delivery - BigInt(appliedAfter)) *
              BigInt(collectShare)) /
              100n,
          );
          const delivered = (net: Poisha, applied: Poisha, costPoisha: Poisha) =>
            orderDeliveredDraft({
              orderId: ORDER_ID,
              occurredAt: AT,
              partial: true,
              courierReceivable: A.courierReceivable,
              courierId: COURIER_ID,
              salesRevenue: A.salesRevenue,
              deliveryIncome: A.deliveryIncome,
              cogs: A.cogs,
              goodsInTransit: A.goodsInTransit,
              customerAdvance: A.customerAdvance,
              salesDiscounts: A.salesDiscounts,
              netItemsPoisha: net,
              deliveryChargePoisha: poisha(delivery),
              advanceAppliedPoisha: applied,
              collectedPoisha: collected,
              costPoisha,
              branchId: null,
              memo: null,
            });
          const booked = [
            delivered(
              amounts.netBeforePoisha,
              appliedBefore,
              cost((entry) => entry.qty),
            ),
          ];
          const backCost = cost((entry) => entry.back);
          const fix =
            amounts.netBeforePoisha === amounts.netAfterPoisha &&
            amounts.advanceReleasedPoisha === 0n &&
            backCost === 0n
              ? []
              : [
                  correction({
                    before: BigInt(amounts.netBeforePoisha),
                    after: BigInt(amounts.netAfterPoisha),
                    released: BigInt(amounts.advanceReleasedPoisha),
                    cost: BigInt(backCost),
                  }),
                ];
          for (const draft of fix) validateJournalDraft(draft);
          const ours = [...booked, ...fix];
          // The true books: the kept pieces delivered, the rest still in transit until the
          // return journal puts them back (Dr Inventory / Cr Goods in transit at backCost).
          const truth = [
            delivered(
              amounts.netAfterPoisha,
              appliedAfter,
              cost((entry) => entry.qty - entry.back),
            ),
          ];
          const same = (subtype: string) => net(ours, subtype) === net(truth, subtype);
          return (
            same('sales_revenue') &&
            same('sales_discounts') &&
            same('courier_receivable') &&
            same('delivery_charge_income') &&
            same('cogs') &&
            net(ours, 'customer_advance') + net(ours, 'other_payable') ===
              net(truth, 'customer_advance') &&
            // The true return: Dr Inventory / Cr Goods in transit at the pieces' dispatch cost.
            net(ours, 'inventory') === net(truth, 'inventory') + BigInt(backCost) &&
            net(ours, 'goods_in_transit') === net(truth, 'goods_in_transit') - BigInt(backCost) &&
            fix.every(balanced)
          );
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('returnShortDraft (D-1030)', () => {
  it('worked example: one of three pieces not in the parcel, claimed from the courier', () => {
    const draft = returnShortDraft({
      orderId: ORDER_ID,
      occurredAt: AT,
      otherReceivable: A.otherReceivable,
      goodsInTransit: A.goodsInTransit,
      valuePoisha: poisha(60_000n),
      branchId: null,
      memo: 'Order ELY-2611-00300: 1 × ELY-KRT-001 not in the parcel (Steadfast)',
    });
    validateJournalDraft(draft);
    expect(draft.idempotencyKey).toBe(`order:${ORDER_ID}:return_short`);
    expect(net([draft], 'other_receivable')).toBe(60_000n);
    expect(net([draft], 'goods_in_transit')).toBe(-60_000n);
  });

  it('balances for any value and refuses nothing', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 9_000_000_000n }), (value) => {
        const draft = returnShortDraft({
          orderId: ORDER_ID,
          occurredAt: AT,
          otherReceivable: A.otherReceivable,
          goodsInTransit: A.goodsInTransit,
          valuePoisha: poisha(value),
          branchId: null,
          memo: null,
        });
        validateJournalDraft(draft);
        return balanced(draft);
      }),
    );
    expect(() =>
      returnShortDraft({
        orderId: ORDER_ID,
        occurredAt: AT,
        otherReceivable: A.otherReceivable,
        goodsInTransit: A.goodsInTransit,
        valuePoisha: poisha(0n),
        branchId: null,
        memo: null,
      }),
    ).toThrow(/no cost/);
  });
});
