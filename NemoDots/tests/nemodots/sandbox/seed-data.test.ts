import { describe, expect, it } from 'vitest';
import {
  deterministicUuid,
  generateSeedData,
} from '../../../src/server/nemodots/sandbox/seed.js';

describe('seed data generator', () => {
  const data = generateSeedData();

  it('is deterministic across calls', () => {
    expect(generateSeedData()).toEqual(data);
  });

  it('has 24 listed products, a hidden PROBE-SKU and 200 orders', () => {
    expect(data.products.filter((p) => p.listed)).toHaveLength(24);
    expect(data.products.filter((p) => !p.listed).map((p) => p.sku)).toEqual([
      'PROBE-SKU',
    ]);
    expect(data.orders).toHaveLength(200);
    expect(new Set(data.orders.map((o) => o.id)).size).toBe(200);
    expect(new Set(data.products.map((p) => p.sku)).size).toBe(25);
  });

  it('order totals equal their lines and only reference stocked, listed products', () => {
    const listed = new Set(
      data.products.filter((p) => p.listed).map((p) => p.sku),
    );
    for (const order of data.orders) {
      expect(order.items.length).toBeGreaterThanOrEqual(1);
      expect(order.items.length).toBeLessThanOrEqual(3);
      expect(new Set(order.items.map((i) => i.sku)).size).toBe(
        order.items.length,
      );
      for (const item of order.items) expect(listed.has(item.sku)).toBe(true);
      expect(order.totalCents).toBe(
        order.items.reduce((sum, i) => sum + i.quantity * i.priceCents, 0),
      );
    }
  });

  it('keeps one scarce SKU for oversell scenarios and a deep PROBE-SKU', () => {
    expect(data.products.find((p) => p.sku === 'SKU-0024')!.quantity).toBe(3);
    expect(data.products.find((p) => p.sku === 'PROBE-SKU')!.quantity).toBe(
      1_000_000,
    );
    expect(
      data.products
        .filter((p) => p.listed && p.sku !== 'SKU-0024')
        .every((p) => p.quantity >= 100),
    ).toBe(true);
  });

  it('uuids are stable v4-shaped ids', () => {
    expect(deterministicUuid('x')).toBe(deterministicUuid('x'));
    expect(deterministicUuid('x')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
