import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cents, checkoutProblems, inventoryRequest, nextPollDelay, retryDelay, shippingAvailability, validateConfig } from '../src/safety.mjs';
import { RunState, assertSafeToBuy } from '../src/state.mjs';
import { validateProduct, shippingName } from '../src/target.mjs';

const config = JSON.parse(await readFile(new URL('../config.json', import.meta.url)));
const valid = {
  trustedCheckout: true, itemCount: 1, tcin: '93620188', quantity: 1,
  fulfillment: 'shipping', zip: '75013', seller: 'Target', addons: false,
  paymentReady: true, totalCents: 97424,
};

test('fulfillment selector excludes details and loading controls', () => {
  assert.ok(shippingName.test('Shipping Not available, selected'));
  assert.ok(shippingName.test('Shipping Get it by Friday'));
  assert.ok(!shippingName.test('Shipping & Returns'));
  assert.ok(!shippingName.test('shipping - loading...'));
});

test('money parsing never rounds an over-limit fractional amount down', () => {
  assert.equal(cents('$1,000.00'), 100000);
  assert.equal(cents('899.99'), 89999);
  for (const value of ['1000.001', 'NaN', 'Infinity', '-5', '', null, undefined, '$899.99 sale $799.99']) assert.equal(cents(value), null);
});
test('accept one shipping console at or below the authorized total', () => {
  assert.deepEqual(checkoutProblems(valid, config), []);
  assert.deepEqual(checkoutProblems({ ...valid, totalCents: 110000 }, config), []);
});
for (const [field, value] of Object.entries({ trustedCheckout: false, itemCount: 2, tcin: 'other', quantity: 2, fulfillment: 'pickup', zip: '10001', seller: 'Other seller', addons: true, paymentReady: false, totalCents: 110001 })) {
  test(`reject unsafe checkout: ${field}`, () => assert.ok(checkoutProblems({ ...valid, [field]: value }, config).length));
}
test('missing evidence always fails closed', () => {
  for (const field of Object.keys(valid)) {
    const missing = { ...valid }; delete missing[field];
    assert.ok(checkoutProblems(missing, config).length, field);
  }
});
test('inventory requires exact product and shipping availability, not pickup', () => {
  const body = { data: { product: { tcin: '93620188', fulfillment: { shipping_options: { availability_status: 'IN_STOCK' } } } } };
  assert.equal(shippingAvailability(body, config.tcin), 'available');
  assert.equal(shippingAvailability(body, 'other'), 'unknown');
  body.data.product.fulfillment.shipping_options.availability_status = 'OUT_OF_STOCK';
  assert.equal(shippingAvailability(body, config.tcin), 'unavailable');
  delete body.data.product.fulfillment.shipping_options;
  assert.equal(shippingAvailability(body, config.tcin), 'unknown');
  assert.equal(shippingAvailability({}, config.tcin), 'unknown');
});
test('HTTP replay requires exact host, inventory GET, TCIN and ZIP', () => {
  const url = 'https://redsky.target.com/redsky_aggregations/v1/web/pdp_fulfillment_v1?tcin=93620188&zip=75013';
  assert.equal(inventoryRequest(url, 'GET', config), true);
  assert.equal(inventoryRequest(url, 'POST', config), false);
  for (const bad of [url.replace('75013', '10001'), url.replace('93620188', '1234'), url.replace('redsky.target.com', 'redsky.target.com.evil.test'), url.replace('pdp_fulfillment_v1', 'checkout'), url.replace('https:', 'http:')]) assert.equal(inventoryRequest(bad, 'GET', config), false);
});
test('retry delay honors Retry-After and increases after failures', () => {
  assert.equal(retryDelay(1, 30, '600'), 600000);
  assert.ok(retryDelay(3, 30) > retryDelay(1, 30));
  assert.equal(retryDelay(1, 30, 'Thu, 19 Nov 2026 00:05:00 GMT', Date.parse('2026-11-19T00:00:00Z')), 300000);
});
test('five-second polls account for response time and skip missed slots', () => {
  assert.equal(config.pollSeconds, 5);
  assert.equal(nextPollDelay(config.pollSeconds, 650), 4350);
  assert.equal(nextPollDelay(config.pollSeconds, 6800), 3200);
  assert.equal(nextPollDelay(config.browserPollSeconds, 650), 14350);
  assert.throws(() => validateConfig({ ...config, browserPollSeconds: 0 }));
});
test('configuration cannot exceed authorized spending or change the product', () => {
  assert.equal(validateConfig(config), config);
  for (const change of [{ maxTotal: 1100.01 }, { maxTotal: NaN }, { maxTotal: 0 }, { pollSeconds: 0 }, { tcin: '123' }, { fulfillment: 'pickup' }]) assert.throws(() => validateConfig({ ...config, ...change }));
});
test('product guard rejects an occupied or unreadable cart and optional extras', () => {
  const product = { correctProduct: true, zipMatches: true, cartCount: 0, checkedExtras: 0, price: '$899.99' };
  assert.doesNotThrow(() => validateProduct(product, config));
  for (const change of [{ correctProduct: false }, { zipMatches: false }, { cartCount: 1 }, { cartCount: null }, { checkedExtras: 1 }, { price: null }, { price: '$1,100.01' }]) assert.throws(() => validateProduct({ ...product, ...change }, config));
});
test('durable purchase state blocks duplicates after restart', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ps5-state-test-'));
  const state = new RunState(dir);
  try {
    await state.acquire();
    await assert.rejects(new RunState(dir).acquire(), /Another bot/);
    for (const phase of ['adding', 'cart', 'checkout', 'submitting', 'submitted', 'confirmed', 'needs-review']) {
      await state.write({ phase });
      const persisted = await new RunState(dir).read();
      assert.equal(persisted.phase, phase);
      assert.throws(() => assertSafeToBuy(persisted), /Automatic retry/);
    }
    assert.doesNotThrow(() => assertSafeToBuy({ phase: 'new' }));
  } finally { await state.release(); await rm(dir, { recursive: true, force: true }); }
});
