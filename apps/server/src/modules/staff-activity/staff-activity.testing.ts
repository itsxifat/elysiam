import { withSystem } from '@elysium/db';
import { createTestUser, grantMembership } from '@elysium/db/testing';
import { sql } from 'drizzle-orm';

import { seedProductWithSkus } from '../inventory/inventory.testing.js';
import { seedCustomer, seedOrder } from '../orders/orders.testing.js';

/**
 * Seeds for staff activity's tests and the route matrix (M57).
 *
 * `seedMissedCallBack` makes the one mistake that needs nothing but an order and a call attempt:
 * a call-back promised three hours ago that nobody made (`call_back_missed`, its key the
 * attempt's id). The order is written at `pending` by `seedOrder`, as the orders fixtures do.
 */

let phone = 1_900_000 + Math.floor(Math.random() * 90_000);

export async function seedSalesAgent(
  orgId: string,
  name = 'Staff activity agent',
): Promise<string> {
  const agent = await createTestUser({ name });
  await grantMembership({ userId: agent.id, orgId, role: 'sales' });
  return agent.id;
}

export async function seedPendingOrder(
  orgId: string,
  createdBy: string,
  status = 'pending',
): Promise<{ id: string; orderNo: string }> {
  const { skus } = await seedProductWithSkus(orgId, `staffact${String(phone)}`, 1);
  const sku = skus[0];
  if (sku === undefined) throw new Error('no SKU seeded');
  phone += 1;
  const customerId = await seedCustomer(orgId, {
    phoneE164: `+88017${String(phone).padStart(8, '0')}`,
    name: 'Staff Activity Buyer',
  });
  return seedOrder(orgId, {
    status,
    customerId,
    createdBy,
    assignedTo: createdBy,
    lines: [
      {
        skuId: sku.id,
        skuCode: sku.code,
        productName: 'Staff activity tee',
        qty: 2,
        unitPricePoisha: 50_000n,
      },
    ],
  });
}

export async function seedMissedCallBack(
  orgId: string,
  agentId?: string,
): Promise<{ key: string; userId: string; orderId: string; orderNo: string }> {
  const userId = agentId ?? (await seedSalesAgent(orgId));
  const order = await seedPendingOrder(orgId, userId);
  const attemptId = await withSystem(
    async (tx) => {
      const rows = await tx.execute<{ id: string }>(sql`
        insert into sales.call_attempts (org_id, order_id, outcome, call_back_at, called_by, called_at)
        values (${orgId}, ${order.id}, 'call_back', now() - interval '3 hours', ${userId},
                now() - interval '4 hours')
        returning id
      `);
      return rows[0]?.id ?? '';
    },
    { orgId },
  );
  return {
    key: `call_back_missed:${attemptId}`,
    userId,
    orderId: order.id,
    orderNo: order.orderNo,
  };
}
