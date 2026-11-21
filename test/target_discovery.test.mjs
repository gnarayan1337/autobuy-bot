import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CDUI_PATH, fulfillmentRequest, allowDiagnosticRequest, fulfillmentResponse, routeDiagnosticRequest } from '../src/target_discovery.mjs';
import { diagnose } from '../src/diagnose.mjs';

const config = { tcin: '93620188', zip: '75013', productName: 'PlayStation 5 Pro Console', productUrl: 'https://www.target.com/p/playstation-5-pro-console/-/A-93620188', navigationTimeoutMs: 5000 };
const cdui = `https://www.target.com${CDUI_PATH}?tcin=${config.tcin}&zip=75013&key=private-key&visitor_id=private-visitor`;
const redsky = `https://redsky.target.com/redsky_aggregations/v1/web/pdp_client_v1?tcin=${config.tcin}&zip=75013`;
const body = JSON.stringify({ page_context: 'private-page-context', modules: [
  { module_type: 'ProductDetailFulfillment', module_placement_id: 'private-placement', enrichment_context: 'private-enrichment' },
  { module_type: 'ProductDetailPrice', module_placement_id: 'price-placement', enrichment_context: 'price-context' },
] });
const request = (url = cdui, method = 'POST', data = body) => ({ url: () => url, method: () => method, postData: () => data });

test('CDUI accepts only the published product-data endpoint and its observed request structure', () => {
  for (const url of [cdui, cdui.replace('www.target.com', 'cdui-orchestrations.target.com')]) {
    assert.equal(allowDiagnosticRequest(url, 'POST', body, config), true);
  }
  for (const url of [
    cdui.replace('https:', 'http:'), cdui.replace('www.target.com', 'www.target.com.evil.test'),
    cdui.replace('www.target.com', 'user:password@www.target.com'), cdui.replace('www.target.com', 'www.target.com:444'),
    cdui.replace('93620188', '94961316'), cdui.replace(CDUI_PATH, CDUI_PATH + '/checkout'),
    cdui + '&tcin=94961316', cdui + '&zip=10001', cdui + '#fragment', cdui.replace('&zip=75013', '&zip=invalid'),
  ]) assert.equal(allowDiagnosticRequest(url, 'POST', body, config), false, url);
  for (const data of [null, '{broken', '{}', JSON.stringify({ ...JSON.parse(body), cart_item: { tcin: config.tcin } }),
    body.replace('ProductDetailFulfillment', 'Checkout'), body.replace('enrichment_context', 'cart_item'),
    body.replace('private-page-context', '')]) {
    assert.equal(allowDiagnosticRequest(cdui, 'POST', data, config), false);
  }
});

test('missing or different ZIP is observable but cannot establish configured shipping', () => {
  for (const url of [cdui.replace('&zip=75013', ''), cdui.replace('zip=75013', 'zip=10001')]) {
    const candidate = fulfillmentRequest(url, 'POST', body, config);
    assert.equal(candidate.allowed, true);
    assert.equal(candidate.zipMatches, false);
    assert.equal(fulfillmentResponse(candidate, 200, { data: {} }, config).outcome, 'destination_unverified');
  }
});

test('ordinary assets pass while cart, order, payment and arbitrary writes remain blocked', () => {
  assert.equal(allowDiagnosticRequest(config.productUrl, 'GET', null, config), true);
  const bundle = 'https://assets.targetimg1.com/webui/top-of-funnel/_next/static/chunks/module-component-product-detail-add-to-cart.89b37c8513936edf.js';
  assert.equal(allowDiagnosticRequest(bundle, 'GET', null, config), true);
  assert.equal(allowDiagnosticRequest(bundle, 'POST', body, config), false);
  assert.equal(allowDiagnosticRequest(bundle.replace('assets.targetimg1.com', 'carts.target.com'), 'GET', null, config), false);
  assert.equal(allowDiagnosticRequest(cdui, 'OPTIONS', null, config), true);
  for (const url of ['https://carts.target.com/web_checkouts/v1/cart_items', 'https://www.target.com/cart',
    'https://www.target.com/checkout', 'https://www.target.com/payment']) {
    for (const method of ['GET', 'POST', 'PUT', 'DELETE']) assert.equal(allowDiagnosticRequest(url, method, body, config), false);
  }
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.equal(allowDiagnosticRequest('https://www.target.com/unrecognized', method, body, config), false);
  }
});

test('challenge, rate limit, redirect and unrecognized responses stay distinct and unknown', () => {
  const candidate = fulfillmentRequest(cdui, 'POST', body, config);
  for (const [status, payload, outcome] of [
    [435, { blockScript: 'private-challenge-url', uuid: 'private-uuid' }, 'challenge'],
    [200, { jsClientSrc: 'private-challenge-url' }, 'challenge'], [403, {}, 'declined'],
    [429, {}, 'rate_limited'], [307, {}, 'redirected'], [500, {}, 'http_error'],
    [200, null, 'invalid_json'], [200, { data: {} }, 'cdui_schema_unverified'],
  ]) {
    const result = fulfillmentResponse(candidate, status, payload, config);
    assert.equal(result.outcome, outcome);
    assert.equal(result.shipping, 'unknown');
    assert.ok(!JSON.stringify(result).includes('private-'));
  }
});

test('CDUI summarizes exact-item fulfillment sections without interpreting an unverified schema', () => {
  const candidate = fulfillmentRequest(cdui, 'POST', body, config);
  const payload = { data: { modules: [{ module_type: 'ProductDetailFulfillment', module_data: { data_by_tcin: [
    { tcin: config.tcin, three_up_sections: [{ label: 'private shopper text' }] },
    { tcin: '94961316', three_up_sections: [{}, {}, {}] },
  ] } }], product: { tcin: config.tcin, fulfillment: { shipping_options: { availability_status: 'IN_STOCK' } } } } };
  const result = fulfillmentResponse(candidate, 200, payload, config);
  assert.deepEqual(result.fulfillmentSectionCounts, [1]);
  assert.equal(result.shipping, 'unknown');
  assert.ok(!JSON.stringify(result).includes('private'));
});

test('RedSky preserves exact-product shipping semantics and requires the requested destination', () => {
  const payload = { data: { product: { tcin: config.tcin, fulfillment: { shipping_options: { availability_status: 'IN_STOCK' } } } } };
  const candidate = fulfillmentRequest(redsky, 'GET', null, config);
  assert.equal(fulfillmentResponse(candidate, 200, payload, config).shipping, 'available');
  payload.data.product.fulfillment.shipping_options.availability_status = 'OUT_OF_STOCK';
  assert.equal(fulfillmentResponse(candidate, 200, payload, config).shipping, 'unavailable');
  assert.equal(fulfillmentResponse({ ...candidate, zipMatches: false }, 200, payload, config).shipping, 'unknown');
  payload.data.product.tcin = '94961316';
  assert.equal(fulfillmentResponse(candidate, 200, payload, config).shipping, 'unknown');
});

test('CDUI forwards once without redirects or retries; cart POST never reaches transport', async () => {
  for (const status of [200, 307, 308, 435]) {
    const calls = [];
    const response = { status: () => status, dispose: async () => calls.push('dispose') };
    const route = { request, fetch: async options => { calls.push(options); return response; },
      fulfill: async () => calls.push('fulfill'), abort: async () => calls.push('abort') };
    const result = await routeDiagnosticRequest(route, config);
    assert.deepEqual(calls[0], { maxRedirects: 0, maxRetries: 0, timeout: 15000 });
    assert.deepEqual(calls.slice(1), [status === 307 || status === 308 ? 'abort' : 'fulfill', 'dispose']);
    assert.equal(result.status, status);
    assert.ok(!JSON.stringify(result).includes('private-'));
  }
  let aborted = 0;
  await routeDiagnosticRequest({ request: () => request('https://carts.target.com/web_checkouts/v1/cart_items'),
    fetch: assert.fail, fallback: assert.fail, abort: async () => aborted++ }, config);
  assert.equal(aborted, 1);
});

test('diagnostic reports a CDUI 435 instead of no_matching_inventory_request and does not replay', async () => {
  class Page extends EventEmitter {
    async goto() {
      this.emit('response', { request, url: () => cdui, status: () => 435,
        json: async () => ({ blockScript: 'private-challenge', uuid: 'private-uuid' }) });
      return { status: () => 200 };
    }
    async close() { this.closed = true; }
    // The fixture has no readable DOM; production uses the existing product reader.
    async locator() { throw new Error('fixture DOM unavailable'); }
  }
  const page = new Page();
  const context = { newPage: async () => page, route: async () => {}, request: { get: assert.fail } };
  const events = [];
  assert.equal(await diagnose(context, config, { waitMs: 100, emit: value => events.push(value) }), 2);
  assert.equal(events.find(event => event.event === 'fulfillment_response').outcome, 'challenge');
  assert.equal(events.at(-1).outcome, 'challenge');
  assert.equal(events.at(-1).directInventoryGetSent, false);
  assert.equal(page.closed, true);
  assert.ok(!JSON.stringify(events).includes('private-'));
});

test('HTTP success requires a successful direct RedSky replay, not just the page response', async () => {
  for (const directStatus of [200, 435]) {
    const payload = { data: { product: { tcin: config.tcin, fulfillment: { shipping_options: { availability_status: 'OUT_OF_STOCK' } } } } };
    class Page extends EventEmitter {
      async goto() {
        this.emit('response', { request: () => request(redsky, 'GET', null), url: () => redsky,
          status: () => 200, json: async () => payload });
        return { status: () => 200 };
      }
      async close() {}
    }
    let gets = 0;
    const context = { newPage: async () => new Page(), route: async () => {}, request: { get: async (url, options) => {
      gets++;
      assert.equal(url, redsky);
      assert.equal(options.maxRedirects, 0);
      assert.equal(options.maxRetries, 0);
      return { status: () => directStatus, json: async () => directStatus === 200 ? payload : { blockScript: 'private-challenge' }, dispose: async () => {} };
    } } };
    const events = [];
    assert.equal(await diagnose(context, config, { waitMs: 5, emit: value => events.push(value) }), directStatus === 200 ? 0 : 2);
    assert.equal(gets, 1);
    assert.equal(events.at(-1).directInventoryGetSent, true);
  }
});
