import { randomUUID } from 'node:crypto';

import { withSystem } from '@elysium/db';
import { sql } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { JobsRuntime } from '../../platform/jobs/jobs.runtime.js';
import {
  ORG_A,
  startHttpHarness,
  type HttpHarness,
  type RoleClient,
} from '../../testing/http-harness.js';
import { seedProductWithSkus, warehouseId } from '../inventory/inventory.testing.js';
import { applyOrderMigrations, seedStockLevel } from '../orders/orders.testing.js';
import { MARKETPLACE_QUEUE_DEFINITIONS } from '../marketplace/marketplace.queues.js';
import { NOTIFY_QUEUES } from '../notify/notify.queues.js';
import { signStorefront } from './signature.js';
import { STOREFRONT_QUEUE_DEFINITIONS } from './storefront.queues.js';
import { insertPublicImageRow, insertTestSiteKey, type TestSiteKey } from './storefront.testing.js';

/**
 * Campaign links on real Postgres (M35b, D-551): links made on the console and read by the
 * website's server by code, and their view counter. The website's tracking is the tracking
 * hub's since M54, tested in `tracking/tracking.e2e.test.ts`.
 */

let harness: HttpHarness;
let jobs: JobsRuntime | undefined;
let admin: RoleClient;
let marketing: RoleClient;
let sales: RoleClient;
let key: TestSiteKey;
let productId = '';
let skuId = '';
let categoryId = '';
const suffix = randomUUID().slice(0, 6);

async function signed(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  idempotencyKey?: string,
) {
  const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
  const timestamp = String(Math.floor(Date.now() / 1000));
  const response = await harness.server.inject({
    method,
    url: path,
    headers: {
      'x-api-key': key.keyId,
      'x-api-timestamp': timestamp,
      'x-api-signature': signStorefront(key.secret, {
        timestamp,
        method,
        pathAndQuery: path,
        ...(raw === undefined ? {} : { idempotencyKey: idempotencyKey ?? '', rawBody: raw }),
      }),
      ...(raw === undefined ? {} : { 'content-type': 'application/json' }),
      ...(idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey }),
    },
    ...(raw === undefined ? {} : { payload: raw }),
  });
  return {
    status: response.statusCode,
    body: (response.body === '' ? undefined : JSON.parse(response.body)) as Record<string, unknown>,
    raw: response.body,
  };
}

function link(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Eid campaign',
    baseType: 'category',
    categoryId,
    customPath: '',
    highlightProductIds: [productId],
    banner: {
      enabled: true,
      text: 'Eid 20% off',
      bgColor: '#B85C3A',
      textColor: '#FFFFFF',
      link: '/shop',
    },
    modal: {
      enabled: false,
      type: 'text',
      title: '',
      text: '',
      imageFileId: null,
      ctaText: '',
      ctaLink: '',
    },
    isActive: true,
    ...overrides,
  };
}

beforeAll(async () => {
  harness = await startHttpHarness('web-marketing');
  await applyOrderMigrations();
  jobs = await JobsRuntime.start({
    role: 'worker',
    connectionString: harness.database.ownerUrl,
    appRole: 'erp_app',
    queues: [...STOREFRONT_QUEUE_DEFINITIONS, ...MARKETPLACE_QUEUE_DEFINITIONS, ...NOTIFY_QUEUES],
    logger: pino({ level: 'silent' }),
    pollingIntervalSeconds: 0.5,
  });
  admin = await harness.asRole('org_admin', ORG_A);
  marketing = await harness.asRole('marketing', ORG_A);
  sales = await harness.asRole('sales', ORG_A);
  key = await insertTestSiteKey(ORG_A);
  const seeded = await seedProductWithSkus(ORG_A, `wm${suffix}`, 1);
  productId = seeded.productId;
  skuId = seeded.skus[0]?.id ?? '';
  const ids = await withSystem(
    async (tx) => {
      await tx.execute(sql`
        update catalog.products set web_visible = true where org_id = ${ORG_A} and id = ${productId}
      `);
      return (
        await tx.execute<{ category_id: string }>(sql`
          select category_id from catalog.products where id = ${productId}
        `)
      )[0];
    },
    { orgId: ORG_A },
  );
  categoryId = ids?.category_id ?? '';
  await seedStockLevel(ORG_A, {
    skuId,
    locationId: await warehouseId(ORG_A),
    qty: 20,
    unitCostPoisha: 60_000n,
  });
}, 300_000);

afterAll(async () => {
  await jobs?.stop();
  await harness.close();
});

describe('campaign links', () => {
  it('are made on the console under a five-digit code and read by the website by it', async () => {
    const created = await marketing.client.request('POST', '/v1/storefront/campaign-links', {
      body: link(),
    });
    expect(created.statusCode, created.body).toBe(201);
    const { id, code } = JSON.parse(created.body) as { id: string; code: string };
    expect(code).toMatch(/^[1-9]\d{4}$/);

    const listed = JSON.parse(
      (await sales.client.request('GET', '/v1/storefront/campaign-links')).body,
    ) as { items: { id: string; path: string; views: number }[] };
    const mine = listed.items.find((item) => item.id === id);
    expect(mine?.path).toBe(`/shop?category=cat-wm${suffix}&cu=${code}`);

    const read = await signed('GET', `/storefront/v1/custom-links/${code}`);
    expect(read.status).toBe(200);
    expect(read.body.customLink).toMatchObject({
      code,
      title: 'Eid campaign',
      basePath: `/shop?category=cat-wm${suffix}`,
      banner: { text: 'Eid 20% off', link: '/shop' },
      modal: null,
    });
    const cards = (read.body.customLink as { highlightProducts: { id: string }[] })
      .highlightProducts;
    expect(cards.map((card) => card.id)).toEqual([productId]);

    for (let i = 0; i < 3; i += 1) {
      expect((await signed('POST', `/storefront/v1/custom-links/${code}/views`, {})).status).toBe(
        200,
      );
    }
    const after = JSON.parse(
      (await marketing.client.request('GET', `/v1/storefront/campaign-links/${id}`)).body,
    ) as { link: { views: number } };
    expect(after.link.views).toBe(3);

    // Switched off, the website no longer finds it, and counts nothing.
    await marketing.client.request('PUT', `/v1/storefront/campaign-links/${id}`, {
      body: link({ isActive: false }),
    });
    expect((await signed('GET', `/storefront/v1/custom-links/${code}`)).status).toBe(404);
    expect((await signed('POST', `/storefront/v1/custom-links/${code}/views`, {})).status).toBe(
      404,
    );
  });

  it('refuse an unsafe path, a foreign image and a sales agent', async () => {
    const unsafe = await marketing.client.request('POST', '/v1/storefront/campaign-links', {
      body: link({ baseType: 'custom', customPath: '//evil.example/x' }),
    });
    expect(unsafe.statusCode).toBe(400);
    const notPublic = await marketing.client.request('POST', '/v1/storefront/campaign-links', {
      body: link({
        modal: {
          enabled: true,
          type: 'image',
          title: 'Hi',
          text: '',
          imageFileId: await insertPublicImageRow(ORG_A, 'product-image'),
          ctaText: '',
          ctaLink: '',
        },
      }),
    });
    expect(notPublic.statusCode).toBe(400);
    const bySales = await sales.client.request('POST', '/v1/storefront/campaign-links', {
      body: link(),
    });
    expect(bySales.statusCode).toBe(403);
  });

  /*
   * M35b joined to M39a's deletes at integration (D-551, D-621): the website's references
   * checker counts a link's category and its highlighted products, so neither is deleted out
   * from under a link already shared, and the usage answer names the link.
   */
  it('keep the category they open and the products they highlight from a delete, and are named', async () => {
    const tag = randomUUID().replace(/-/g, '').slice(0, 6);
    const madeCategory = await admin.client.request('POST', '/v1/catalog/categories', {
      body: { name: `Eid range ${tag}`, slug: `eid-range-${tag}`, code: `L${tag.toUpperCase()}` },
    });
    expect(madeCategory.statusCode, madeCategory.body).toBeLessThan(300);
    const category = (JSON.parse(madeCategory.body) as { id: string }).id;
    const madeProduct = await admin.client.request('POST', '/v1/catalog/products', {
      body: {
        name: `Eid kurta ${tag}`,
        slug: `eid-kurta-${tag}`,
        pricePoisha: '150000',
        status: 'active',
      },
    });
    expect(madeProduct.statusCode, madeProduct.body).toBeLessThan(300);
    const product = (JSON.parse(madeProduct.body) as { id: string }).id;

    const created = await marketing.client.request('POST', '/v1/storefront/campaign-links', {
      body: link({ title: 'Eid range', categoryId: category, highlightProductIds: [product] }),
    });
    expect(created.statusCode, created.body).toBe(201);
    const { id, code } = JSON.parse(created.body) as { id: string; code: string };
    const named = {
      reason: 'campaign_links',
      count: 1,
      movable: false,
      examples: [{ id, label: `Eid range (${code})` }],
    };

    interface Usage {
      readonly canDelete: boolean;
      readonly canEmptyAndDelete: boolean;
      readonly uses: readonly { reason: string; count: number; movable: boolean }[];
    }
    const usageOf = async (url: string) =>
      JSON.parse((await admin.client.request('GET', url)).body) as Usage;
    const refusal = async (method: 'DELETE' | 'POST', url: string, body?: unknown) => {
      const response = await admin.client.request(method, url, body === undefined ? {} : { body });
      return {
        status: response.statusCode,
        ...(JSON.parse(response.body) as { code?: string; detail?: string }),
      };
    };

    // The category: nothing but the link uses it, and the link is not moved for it.
    const categoryUsage = await usageOf(`/v1/catalog/categories/${category}/usage`);
    expect(categoryUsage).toMatchObject({ canDelete: false, canEmptyAndDelete: false });
    expect(categoryUsage.uses).toEqual([named]);
    const refusedCategory = await refusal('DELETE', `/v1/catalog/categories/${category}`);
    expect(refusedCategory).toMatchObject({ status: 409, code: 'CATALOG_IN_USE' });
    expect(refusedCategory.detail).toContain('1 campaign link');
    const refusedEmpty = await refusal(
      'POST',
      `/v1/catalog/categories/${category}/empty-and-delete`,
      { targetCategoryId: categoryId },
    );
    expect(refusedEmpty).toMatchObject({ status: 409, code: 'CATALOG_IN_USE' });
    // The way out names the link, not a discount.
    expect(refusedEmpty.detail).toContain(
      'Point the campaign link elsewhere or delete it first, or archive the category instead.',
    );
    expect(refusedEmpty.detail).not.toContain('discount');

    // The highlighted product.
    const productUsage = await usageOf(`/v1/catalog/products/${product}/usage`);
    expect(productUsage.canDelete).toBe(false);
    expect(productUsage.uses).toEqual([named]);
    const refusedProduct = await refusal('DELETE', `/v1/catalog/products/${product}`);
    expect(refusedProduct).toMatchObject({ status: 409, code: 'CATALOG_IN_USE' });
    expect(refusedProduct.detail).toContain('1 campaign link');

    // Switched off, the link still keeps both: switched on again, it must still open them.
    const off = await marketing.client.request('PUT', `/v1/storefront/campaign-links/${id}`, {
      body: link({
        title: 'Eid range',
        categoryId: category,
        highlightProductIds: [product],
        isActive: false,
      }),
    });
    expect(off.statusCode, off.body).toBe(200);
    expect((await refusal('DELETE', `/v1/catalog/categories/${category}`)).status).toBe(409);
    expect((await refusal('DELETE', `/v1/catalog/products/${product}`)).status).toBe(409);

    // With the link deleted, both go.
    const gone = await marketing.client.request('DELETE', `/v1/storefront/campaign-links/${id}`);
    expect(gone.statusCode, gone.body).toBeLessThan(300);
    expect((await usageOf(`/v1/catalog/categories/${category}/usage`)).canDelete).toBe(true);
    const deletedProduct = await admin.client.request('DELETE', `/v1/catalog/products/${product}`);
    expect(deletedProduct.statusCode, deletedProduct.body).toBeLessThan(300);
    const deletedCategory = await admin.client.request(
      'DELETE',
      `/v1/catalog/categories/${category}`,
    );
    expect(deletedCategory.statusCode, deletedCategory.body).toBeLessThan(300);
  });
});
