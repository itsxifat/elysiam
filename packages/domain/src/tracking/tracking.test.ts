import { createHash } from 'node:crypto';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { poisha } from '../money/index.js';

import {
  cleanSignals,
  cleanStageRoutes,
  DEFAULT_PURCHASE_STAGE,
  eventStatus,
  eventTooOld,
  fbcFromClickId,
  ORDER_STAGES,
  orderActionSource,
  orderCustomData,
  orderEventDestinations,
  orderGa4Body,
  orderMetaEvent,
  orderTrackingUser,
  PURCHASE_STAGES,
  refundCustomData,
  refundDue,
  refundEventId,
  signalsPresent,
  stageEventId,
  stageEventName,
  stageForStatus,
  stageValue,
  syntheticGa4ClientId,
  type DestinationState,
  type OrderEventFacts,
  type OrderStage,
} from './index.js';

const sha = (value: string): string => createHash('sha256').update(value).digest('hex');

const ORDER_STATUSES = [
  'pending',
  'confirmed',
  'on_hold',
  'packed',
  'shipped',
  'delivered',
  'partially_delivered',
  'return_in_transit',
  'returned',
  'cancelled',
  'exchange',
] as const;

const facts: OrderEventFacts = {
  orderId: '0b9b2c4e-8a51-4a4e-9a63-1d1c0f6a2b11',
  orderNo: '2611100042',
  channel: 'facebook',
  customerId: '6f1c2a54-0c6b-4c3e-8d0e-3a8f5e2b9c77',
  phoneE164: '+8801712345678',
  email: 'Rahim.Uddin@Example.com',
  name: 'Rahim Uddin',
  city: 'Dhaka',
  lines: [
    { skuCode: 'PNJ-RED-M', productName: 'Panjabi', qty: 2, unitPricePoisha: poisha(125000n) },
    { skuCode: 'PNJ-RED-L', productName: 'Panjabi', qty: 0, unitPricePoisha: poisha(125000n) },
  ],
};

describe('stages (D-957)', () => {
  it('confirmed is the owner’s Purchase stage', () => {
    expect(DEFAULT_PURCHASE_STAGE).toBe('confirmed');
    expect(stageEventName('confirmed', 'confirmed')).toBe('Purchase');
    expect(stageEventName('placed', 'confirmed')).toBe('OrderPlaced');
    expect(stageEventName('delivered', 'confirmed')).toBe('OrderDelivered');
  });

  it('maps every status to a stage or to none', () => {
    expect(ORDER_STATUSES.map((status) => stageForStatus(status))).toEqual([
      null,
      'confirmed',
      null,
      null,
      null,
      'delivered',
      'delivered',
      null,
      'returned',
      'cancelled',
      null,
    ]);
  });

  it('keeps the website’s Purchase id and names the other stages after themselves', () => {
    expect(stageEventId('confirmed', '2611100042', 'confirmed')).toBe('purchase_2611100042');
    expect(stageEventId('placed', '2611100042', 'confirmed')).toBe('placed_2611100042');
    expect(stageEventId('placed', '2611100042', 'placed')).toBe('purchase_2611100042');
    expect(refundEventId('returned', '2611100042')).toBe('refund_returned_2611100042');
  });

  it('never makes two events for one stage, however often and in whatever order the status changes are heard', () => {
    const status = fc.constantFrom(...ORDER_STATUSES);
    const purchase = fc.constantFrom(...PURCHASE_STAGES);
    fc.assert(
      fc.property(fc.array(status, { maxLength: 40 }), purchase, (heard, purchaseStage) => {
        const ids = new Map<string, OrderStage>();
        for (const to of heard) {
          const stage = stageForStatus(to);
          if (stage === null) continue;
          ids.set(stageEventId(stage, '2611100042', purchaseStage), stage);
        }
        const stages = new Set(ids.values());
        // One id per stage, and exactly one Purchase id at most.
        expect(ids.size).toBe(stages.size);
        const purchases = [...ids.keys()].filter((id) => id.startsWith('purchase_'));
        expect(purchases.length).toBeLessThanOrEqual(1);
      }),
    );
  });
});

describe('values and refunds (D-960, D-967)', () => {
  it('values each stage', () => {
    const net = poisha(250000n);
    expect(stageValue('confirmed', { netItemsPoisha: net, deliveredPoisha: null })).toBe(net);
    expect(stageValue('delivered', { netItemsPoisha: net, deliveredPoisha: poisha(125000n) })).toBe(
      poisha(125000n),
    );
    expect(stageValue('returned', { netItemsPoisha: net, deliveredPoisha: poisha(125000n) })).toBe(
      poisha(125000n),
    );
    expect(stageValue('cancelled', { netItemsPoisha: net, deliveredPoisha: null })).toBe(net);
  });

  it('refunds the rest of a cancel, the shortfall of a partial delivery, and nothing twice', () => {
    const bought = poisha(250000n);
    expect(
      refundDue({
        stage: 'cancelled',
        purchasePoisha: bought,
        deliveredPoisha: null,
        refundedPoisha: poisha(0n),
      }),
    ).toBe(bought);
    expect(
      refundDue({
        stage: 'delivered',
        purchasePoisha: bought,
        deliveredPoisha: poisha(125000n),
        refundedPoisha: poisha(0n),
      }),
    ).toBe(poisha(125000n));
    // The undelivered half comes back after the partial delivery already refunded it.
    expect(
      refundDue({
        stage: 'returned',
        purchasePoisha: bought,
        deliveredPoisha: poisha(125000n),
        refundedPoisha: poisha(125000n),
      }),
    ).toBe(poisha(0n));
    expect(
      refundDue({
        stage: 'confirmed',
        purchasePoisha: bought,
        deliveredPoisha: null,
        refundedPoisha: poisha(0n),
      }),
    ).toBe(poisha(0n));
  });

  it('never refunds more than was bought, whatever happens after the purchase', () => {
    const amount = fc.bigInt({ min: 0n, max: 10_000_000_00n });
    const later = fc.constantFrom<OrderStage>('delivered', 'returned', 'cancelled');
    fc.assert(
      fc.property(amount, fc.array(fc.tuple(later, amount), { maxLength: 6 }), (bought, steps) => {
        let refunded = 0n;
        for (const [stage, delivered] of steps) {
          const due = refundDue({
            stage,
            purchasePoisha: poisha(bought),
            deliveredPoisha: poisha(delivered > bought ? bought : delivered),
            refundedPoisha: poisha(refunded),
          });
          expect(due >= 0n).toBe(true);
          refunded += due;
          expect(refunded <= bought).toBe(true);
        }
      }),
    );
  });

  it('refunds a partly delivered, then returned, order back to exactly what was not kept', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10_000_000_00n }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (bought, share) => {
          const kept = BigInt(Math.floor(Number(bought) * share));
          let refunded = 0n;
          for (const stage of ['delivered', 'returned'] as const) {
            refunded += refundDue({
              stage,
              purchasePoisha: poisha(bought),
              deliveredPoisha: poisha(kept),
              refundedPoisha: poisha(refunded),
            });
          }
          expect(refunded).toBe(bought - kept);
        },
      ),
    );
  });
});

describe('routing (D-957, D-966, D-967)', () => {
  const ready = (kind: DestinationState['kind']): DestinationState => ({
    kind,
    enabled: true,
    ready: true,
  });
  const all = [ready('google_ads'), ready('ga4'), ready('meta'), ready('tiktok')];

  it('sends a chat order’s Purchase everywhere but GA4 unless the brand asked', () => {
    const base = {
      kind: 'stage' as const,
      stage: 'confirmed' as const,
      routes: {},
      destinations: all,
      order: { channel: 'facebook', hasGaClientId: false },
    };
    expect(orderEventDestinations({ ...base, chatToGa4: false })).toEqual([
      'meta',
      'tiktok',
      'google_ads',
    ]);
    expect(orderEventDestinations({ ...base, chatToGa4: true })).toEqual([
      'meta',
      'ga4',
      'tiktok',
      'google_ads',
    ]);
  });

  it('sends a refund to GA4 alone, and nothing to a platform switched off, unready or routed away', () => {
    expect(
      orderEventDestinations({
        kind: 'refund',
        stage: 'cancelled',
        routes: {},
        destinations: all,
        order: { channel: 'website', hasGaClientId: true },
        chatToGa4: false,
      }),
    ).toEqual(['ga4']);
    expect(
      orderEventDestinations({
        kind: 'stage',
        stage: 'delivered',
        routes: cleanStageRoutes({
          delivered: { meta: false, ga4: 'no' },
          nonsense: { meta: true },
        }),
        destinations: [
          ready('meta'),
          ready('ga4'),
          { kind: 'tiktok', enabled: false, ready: true },
          { kind: 'google_ads', enabled: true, ready: false },
        ],
        order: { channel: 'website', hasGaClientId: true },
        chatToGa4: false,
      }),
    ).toEqual(['ga4']);
  });

  it('names the action source Meta documents for each channel', () => {
    expect(orderActionSource('website', 'https://shop.example/checkout')).toBe('website');
    expect(orderActionSource('website', undefined)).toBe('other');
    expect(orderActionSource('whatsapp', undefined)).toBe('chat');
    expect(orderActionSource('phone', undefined)).toBe('phone_call');
    expect(orderActionSource('marketplace', undefined)).toBe('other');
  });

  it('skips what a platform would refuse or misdate', () => {
    const now = new Date('2026-11-10T12:00:00Z');
    expect(eventTooOld('meta', new Date('2026-11-04T12:00:00Z'), now)).toBe(false);
    expect(eventTooOld('meta', new Date('2026-11-03T11:00:00Z'), now)).toBe(true);
    expect(eventTooOld('ga4', new Date('2026-11-08T12:00:00Z'), now)).toBe(false);
    expect(eventTooOld('ga4', new Date('2026-11-07T12:00:00Z'), now)).toBe(true);
  });
});

describe('payloads (check 4)', () => {
  const signals = cleanSignals({
    fbp: 'fb.1.1731200000000.123456789',
    fbclid: 'IwAR0abc',
    gaClientId: '1234567890.1731200000',
    ip: '203.0.113.7',
    userAgent: 'Mozilla/5.0',
    eventSourceUrl: 'https://shop.example/checkout',
    unknown: 'x',
    gclid: 'bad value with ü',
  });

  it('keeps known, printable signals and an https page only', () => {
    expect(Object.keys(signals).sort()).toEqual([
      'eventSourceUrl',
      'fbclid',
      'fbp',
      'gaClientId',
      'ip',
      'userAgent',
    ]);
    expect(cleanSignals({ eventSourceUrl: 'http://shop.example' })).toEqual({});
    expect(signalsPresent(signals)).toMatchObject({ fbp: true, fbc: false, gclid: false });
  });

  it('builds Meta’s event with hashes only, a stable id and BDT to the poisha', () => {
    const user = orderTrackingUser(facts, signals, {
      sendNameAndCity: true,
      placedAt: new Date('2026-11-10T08:00:00Z'),
    });
    const event = orderMetaEvent({
      eventName: stageEventName('confirmed', 'confirmed'),
      eventId: stageEventId('confirmed', facts.orderNo, 'confirmed'),
      eventTime: new Date('2026-11-10T10:00:00Z'),
      actionSource: orderActionSource(facts.channel, signals.eventSourceUrl),
      eventSourceUrl: signals.eventSourceUrl,
      user,
      customData: orderCustomData(facts, poisha(250050n)),
      hash: sha,
      defaultCountryCode: '880',
    });
    const text = JSON.stringify(event);
    for (const plain of [
      '8801712345678',
      '01712345678',
      'rahim',
      'Rahim',
      'example.com',
      'dhaka',
    ]) {
      expect(text.includes(plain)).toBe(false);
    }
    expect(event).toMatchObject({
      event_name: 'Purchase',
      event_id: 'purchase_2611100042',
      event_time: 1794304800,
      action_source: 'chat',
      custom_data: {
        currency: 'BDT',
        value: 2500.5,
        order_id: '2611100042',
        contents: [{ id: 'PNJ-RED-M', quantity: 2, item_price: 1250, name: 'Panjabi' }],
        num_items: 2,
      },
    });
    const userData = event.user_data as Record<string, string>;
    expect(userData.ph).toBe(sha('8801712345678'));
    expect(userData.em).toBe(sha('rahim.uddin@example.com'));
    expect(userData.fn).toBe(sha('rahim'));
    expect(userData.ct).toBe(sha('dhaka'));
    expect(userData.fbc).toBe(fbcFromClickId('IwAR0abc', new Date('2026-11-10T08:00:00Z')));
    expect(userData.fbp).toBe('fb.1.1731200000000.123456789');
    // A chat order has no page address to send.
    expect(event.event_source_url).toBeUndefined();
  });

  it('leaves names and city out without consent', () => {
    const user = orderTrackingUser(facts, {}, { sendNameAndCity: false, placedAt: new Date() });
    expect(user.firstName).toBeUndefined();
    expect(user.city).toBeUndefined();
  });

  it('builds GA4’s purchase and refund under one transaction id', () => {
    const purchase = orderGa4Body({
      eventName: 'Purchase',
      eventId: 'purchase_2611100042',
      eventTime: new Date('2026-11-10T10:00:00Z'),
      clientId: signals.gaClientId ?? '',
      customerId: facts.customerId,
      customData: orderCustomData(facts, poisha(250000n)),
    });
    expect(purchase).toMatchObject({
      client_id: '1234567890.1731200000',
      user_id: facts.customerId,
      events: [
        {
          name: 'purchase',
          params: { transaction_id: '2611100042', value: 2500, currency: 'BDT' },
        },
      ],
    });
    const refund = orderGa4Body({
      eventName: 'refund',
      eventId: 'refund_returned_2611100042',
      eventTime: new Date('2026-11-12T10:00:00Z'),
      clientId: signals.gaClientId ?? '',
      customerId: facts.customerId,
      customData: refundCustomData(facts.orderNo, poisha(125000n)),
    });
    expect(refund).toMatchObject({
      events: [
        { name: 'refund', params: { transaction_id: '2611100042', value: 1250, currency: 'BDT' } },
      ],
    });
    expect(JSON.stringify([purchase, refund]).includes('8801712345678')).toBe(false);
  });

  it('makes one stable GA4 client id per buyer, shaped like GA4’s', () => {
    const id = syntheticGa4ClientId(facts.customerId, sha);
    expect(id).toMatch(/^[1-9][0-9]*\.[1-9][0-9]*$/);
    expect(syntheticGa4ClientId(facts.customerId.toUpperCase(), sha)).toBe(id);
    expect(syntheticGa4ClientId('another', sha)).not.toBe(id);
  });
});

describe('the log', () => {
  it('sums an event’s deliveries into one status', () => {
    expect(eventStatus([])).toBe('skipped');
    expect(eventStatus(['sent', 'skipped'])).toBe('sent');
    expect(eventStatus(['sent', 'failed'])).toBe('partial');
    expect(eventStatus(['failed', 'skipped'])).toBe('failed');
    expect(eventStatus(['queued', 'sent'])).toBe('queued');
    expect(eventStatus(['waiting'])).toBe('waiting');
  });

  it('lists every stage once', () => {
    expect(new Set(ORDER_STAGES).size).toBe(ORDER_STAGES.length);
  });
});
