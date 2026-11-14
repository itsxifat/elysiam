import { describe, expect, it } from 'vitest';

import { TargetError } from './errors.js';
import { bonusRuleToJson, evaluateBonus, parseBonusRule } from './index.js';

/**
 * M57 check 6's arithmetic (D-1001): a bonus rule's `mistakes` block. Table-driven, as M20's
 * evaluator tests are. A target of 100 orders, 120 achieved: tier one pays ৳2,000 flat, tier two
 * ৳50 for each of the 20 above target, ৳3,000 in all before mistakes.
 */
const RULE = {
  metric: 'confirmed_orders',
  tiers: [
    { gte_pct: 100, amount_poisha: 200000 },
    { gte_pct: 110, per_unit_above_target_poisha: 5000 },
  ],
  mistakes: {
    per_mistake_poisha: 50000,
    kinds: ['wrong_item_shipped', 'address_not_verified'],
    max_poisha: 200000,
  },
};
const RESULT = { targetValue: 100n, achieved: 120n };

describe('a bonus rule’s mistakes block', () => {
  it.each([
    ['the switch off: no deduction whatever the mistakes', undefined, 300000n, 0n, 0],
    ['no mistakes', {}, 300000n, 0n, 0],
    ['one counted mistake: ৳500 off', { wrong_item_shipped: 1 }, 250000n, 50000n, 1],
    [
      'two kinds counted, one not in the rule',
      { wrong_item_shipped: 1, address_not_verified: 2, slow_first_reply: 9 },
      150000n,
      150000n,
      3,
    ],
    ['capped at ৳2,000', { wrong_item_shipped: 7 }, 100000n, 200000n, 7],
  ] as const)('%s', (_, mistakes, amount, deduction, counted) => {
    const result = evaluateBonus(parseBonusRule(RULE), RESULT, mistakes);
    expect(result.beforeMistakesPoisha).toBe(300000n);
    expect(result.amountPoisha).toBe(amount);
    expect(result.mistakeDeductionPoisha).toBe(deduction);
    expect(result.mistakesCounted).toBe(counted);
  });

  it('never takes the bonus below zero', () => {
    const rule = parseBonusRule({
      ...RULE,
      mistakes: { per_mistake_poisha: 100000, kinds: ['wrong_item_shipped'] },
    });
    const result = evaluateBonus(rule, RESULT, { wrong_item_shipped: 10 });
    expect(result.amountPoisha).toBe(0n);
    expect(result.mistakeDeductionPoisha).toBe(300000n);
    // Below target: no bonus, and nothing to take.
    const missed = evaluateBonus(
      rule,
      { targetValue: 100n, achieved: 50n },
      { wrong_item_shipped: 3 },
    );
    expect(missed.amountPoisha).toBe(0n);
    expect(missed.mistakeDeductionPoisha).toBe(0n);
  });

  it('a rule without the block pays the same with or without mistakes', () => {
    const rule = parseBonusRule({ metric: RULE.metric, tiers: RULE.tiers });
    expect(rule.mistakes).toBeNull();
    expect(evaluateBonus(rule, RESULT, { wrong_item_shipped: 4 }).amountPoisha).toBe(300000n);
  });

  it.each([
    [{ per_mistake_poisha: 0, kinds: ['wrong_scan'] }, /more than zero/],
    [{ per_mistake_poisha: 100, kinds: [] }, /at least one kind/],
    [{ per_mistake_poisha: 100, kinds: ['late'] }, /not a kind of mistake/],
    [{ per_mistake_poisha: 100, kinds: ['wrong_scan'], fine: 1 }, /not part of the block/],
    ['all', /JSON object/],
  ])('refuses a block that is not right: %j', (mistakes, message) => {
    expect(() => parseBonusRule({ ...RULE, mistakes })).toThrow(TargetError);
    expect(() => parseBonusRule({ ...RULE, mistakes })).toThrow(message);
  });

  it('round-trips through its JSON', () => {
    const rule = parseBonusRule(RULE);
    expect(parseBonusRule(bonusRuleToJson(rule))).toEqual(rule);
  });
});
