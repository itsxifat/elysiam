import { businessDate } from '../dates/index.js';
import {
  idempotencyKey,
  LedgerError,
  type JournalDraft,
  type JournalLineDraft,
} from '../ledger/index.js';
import { ZERO, type Poisha } from '../money/index.js';
import { assertSubtype, lineBranch, type PostingAccount } from './supply-received.js';

/**
 * Pieces of a partly delivered order that came back after all (D-1028).
 *
 * A courier's "partially delivered" names the money and never the pieces, so the delivery was
 * booked as every piece kept with the collection short (`orderDeliveredDraft`'s difference on
 * Sales discounts). When the parcel is opened at the return station and some of those pieces are
 * in it, the delivery was worth less than was booked. This journal is the difference between the
 * delivery as booked and the delivery with the true pieces, at the same collected amount:
 *
 *     Dr Sales revenue        the net value of the pieces that came back (before − after)
 *       Cr Sales discounts    the same, less any advance that no longer applies
 *       Cr Other payables     the advance paid for pieces that came back: owed to the buyer
 *     Dr Inventory
 *       Cr COGS               the pieces at their dispatch cost: they were never sold
 *
 * The courier receivable is untouched: what the rider collected did not change, and the
 * courier's statement is still the check on it. Net sales do not move (revenue and the discount
 * that absorbed the shortfall fall together), and gross profit rises by the cost of the pieces,
 * which go back on the shelf through `receiveCustomerReturn` at the same value.
 *
 * **The advance.** The delivery applied what the buyer had prepaid up to what the delivery was
 * worth (`applicableAdvance`). Worth less now, it may apply less, and the rest is the buyer's
 * money for pieces they returned. The advance's rows only ever grow what they applied (0088's
 * trigger), so that money is not put back on them: it is owed to the buyer in Other payables,
 * for accounts to refund. Rare, and named in the memo.
 *
 * **Signs.** `before − after` is never negative in practice, but the order-level discount is
 * apportioned with rounding and a poisha can fall either way, so each line takes the side its
 * sign gives rather than refusing a real receipt over one poisha.
 */

export interface OrderPartialReturnInput {
  /** The order's id. `order:<uuid>:partial_returned`. */
  readonly orderId: string;
  readonly occurredAt: Date;
  readonly salesRevenue: PostingAccount;
  readonly salesDiscounts: PostingAccount;
  readonly inventory: PostingAccount;
  readonly cogs: PostingAccount;
  /** Needed only when an advance no longer applies. */
  readonly otherPayable?: PostingAccount | undefined;
  /** Net item value recognised at delivery, and with the pieces that came back taken out. */
  readonly netBeforePoisha: Poisha;
  readonly netAfterPoisha: Poisha;
  /** The advance the delivery applied that the smaller delivery no longer can. */
  readonly advanceReleasedPoisha: Poisha;
  /** Σ pieces that came back from the delivered count × their dispatch cost. */
  readonly costPoisha: Poisha;
  readonly branchId: string | null;
  readonly memo: string | null;
}

function side(
  account: PostingAccount,
  branchId: string | null,
  /** Positive is a debit, negative a credit. */
  amount: bigint,
  memo: string | null,
): JournalLineDraft | null {
  if (amount === 0n) return null;
  const magnitude = (amount > 0n ? amount : -amount) as Poisha;
  return {
    accountId: account.accountId,
    debitPoisha: amount > 0n ? magnitude : ZERO,
    creditPoisha: amount > 0n ? ZERO : magnitude,
    branchId: lineBranch(account, branchId),
    partyType: null,
    partyId: null,
    memo,
  };
}

export function orderPartialReturnDraft(input: OrderPartialReturnInput): JournalDraft {
  assertSubtype(input.salesRevenue, 'sales_revenue', 'Sales');
  assertSubtype(input.salesDiscounts, 'sales_discounts', 'The collection difference');
  assertSubtype(input.inventory, 'inventory', 'Returned stock');
  assertSubtype(input.cogs, 'cogs', 'Cost of goods sold');
  for (const [what, amount] of [
    ['The net value before', input.netBeforePoisha],
    ['The net value after', input.netAfterPoisha],
    ['The advance released', input.advanceReleasedPoisha],
    ['The dispatch cost', input.costPoisha],
  ] as const) {
    if (amount < 0n) {
      throw new LedgerError('POSTING_INPUT_INVALID', `${what} cannot be negative.`);
    }
  }
  if (input.advanceReleasedPoisha > 0n) {
    if (input.otherPayable === undefined) {
      throw new LedgerError(
        'POSTING_INPUT_INVALID',
        'An advance that no longer applies is owed to the buyer in Other payables.',
      );
    }
    assertSubtype(input.otherPayable, 'other_payable', 'The refund owed');
  }

  // Widened to `bigint` before negating, as `orderDeliveredDraft` does: these are plain integers.
  const revenue: bigint = input.netBeforePoisha - input.netAfterPoisha;
  const released: bigint = input.advanceReleasedPoisha;
  const cost: bigint = input.costPoisha;
  const lines = [
    side(input.salesRevenue, input.branchId, revenue, null),
    side(
      input.salesDiscounts,
      input.branchId,
      released - revenue,
      'Pieces of a partly delivered order came back.',
    ),
    input.otherPayable === undefined
      ? null
      : side(
          input.otherPayable,
          input.branchId,
          -released,
          'Advance paid for pieces that came back: refund owed to the buyer.',
        ),
    side(input.inventory, input.branchId, cost, null),
    side(input.cogs, input.branchId, -cost, null),
  ].filter((line): line is JournalLineDraft => line !== null);

  if (lines.length === 0) {
    // Pieces carried at no price and no cost: the movements are the record, and a journal of
    // zero cannot exist. The caller skips the post.
    throw new LedgerError(
      'POSTING_INPUT_INVALID',
      'Those pieces carry no value, so taking them back posts nothing.',
    );
  }

  return {
    businessDate: businessDate(input.occurredAt),
    sourceType: 'order',
    sourceId: input.orderId.toLowerCase(),
    event: 'partial_returned',
    idempotencyKey: idempotencyKey('order', input.orderId, 'partial_returned'),
    memo: input.memo,
    reversesJournalId: null,
    lines,
  };
}

/**
 * Pieces the courier did not bring back (D-1030, closing D-940's question by its assumed answer).
 *
 * A short receipt books what came back, and the pieces that did not stayed in Goods in transit
 * for ever: stock the books said a courier held, long after the parcel was home. They are a
 * claim on the courier, so a short receipt moves them there, at their dispatch value:
 *
 *     Dr Other receivables (courier claim) / Cr Goods in transit
 *
 * Not written off: an expense is a decision with an approval behind it (§7's write-off), and a
 * claim may still be paid. Accounts settles it either way, from Other receivables.
 */
export interface ReturnShortInput {
  /** The order's id. `order:<uuid>:return_short`. */
  readonly orderId: string;
  readonly occurredAt: Date;
  readonly otherReceivable: PostingAccount;
  readonly goodsInTransit: PostingAccount;
  /** Σ pieces not in the parcel × their dispatch cost. Positive. */
  readonly valuePoisha: Poisha;
  readonly branchId: string | null;
  /** What is missing and from which courier, for whoever settles the claim. */
  readonly memo: string | null;
}

export function returnShortDraft(input: ReturnShortInput): JournalDraft {
  assertSubtype(input.otherReceivable, 'other_receivable', 'The courier claim');
  assertSubtype(input.goodsInTransit, 'goods_in_transit', 'Stock with the courier');
  if (input.valuePoisha <= 0n) {
    throw new LedgerError(
      'POSTING_INPUT_INVALID',
      'Those pieces are carried at no cost, so the claim posts nothing.',
    );
  }
  return {
    businessDate: businessDate(input.occurredAt),
    sourceType: 'order',
    sourceId: input.orderId.toLowerCase(),
    event: 'return_short',
    idempotencyKey: idempotencyKey('order', input.orderId, 'return_short'),
    memo: input.memo,
    reversesJournalId: null,
    lines: [
      {
        accountId: input.otherReceivable.accountId,
        debitPoisha: input.valuePoisha,
        creditPoisha: ZERO,
        branchId: lineBranch(input.otherReceivable, input.branchId),
        partyType: null,
        partyId: null,
        memo: 'Courier claim: pieces not in the returned parcel.',
      },
      {
        accountId: input.goodsInTransit.accountId,
        debitPoisha: ZERO,
        creditPoisha: input.valuePoisha,
        branchId: lineBranch(input.goodsInTransit, input.branchId),
        partyType: null,
        partyId: null,
        memo: null,
      },
    ],
  };
}
