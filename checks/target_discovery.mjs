// Browser/HTTP integration with local responses only; no retailer traffic.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { diagnose } from '../src/diagnose.mjs';
import { CDUI_PATH } from '../src/target_discovery.mjs';

const config = { tcin: '93620188', zip: '75013', productName: 'PlayStation 5 Pro Console', productUrl: 'https://www.target.com/p/playstation-5-pro-console/-/A-93620188', navigationTimeoutMs: 5000 };
const cdui = `https://www.target.com${CDUI_PATH}?tcin=${config.tcin}&zip=75013`;
const bundleUrl = 'https://assets.targetimg1.com/webui/top-of-funnel/_next/static/chunks/module-component-product-detail-add-to-cart.fixture.js';
const body = { page_context: 'fixture-page', modules: [{ module_type: 'ProductDetailFulfillment', module_placement_id: 'fixture-module', enrichment_context: 'fixture-context' }] };
let fixtureStatus, serverCalls;
const server = createServer((req, res) => {
  serverCalls.push(req.url);
  if (req.url !== '/enrich') { res.writeHead(500); res.end(); return; }
  res.writeHead(fixtureStatus, { 'Content-Type': 'application/json', Location: '/cart' });
  res.end(JSON.stringify(fixtureStatus === 435 ? { blockScript: 'fixture-challenge' } : { data: { modules: [
    { module_type: 'ProductDetailFulfillment', module_data: { data_by_tcin: [{ tcin: config.tcin, three_up_sections: [{}] }] } },
  ] } }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const localUrl = `http://127.0.0.1:${server.address().port}/enrich`;
const browser = await chromium.launch({ channel: process.argv.includes('--chromium') ? undefined : 'chrome', headless: true });
try {
  for (fixtureStatus of [200, 435, 307]) {
    serverCalls = [];
    const context = await browser.newContext({ serviceWorkers: 'block' });
    try {
      await context.route('**/*', async route => {
        if (route.request().url() === bundleUrl) return route.fulfill({ contentType: 'application/javascript', body: `
          fetch(${JSON.stringify(cdui)}, {method:'POST',headers:{'Content-Type':'application/json'},body:${JSON.stringify(JSON.stringify(body))}})
            .then(r=>r.json()).then(data=>{if(data.data) document.querySelector('#SHIPPING').textContent='Shipping Arrives tomorrow';}).catch(()=>{});
          fetch('https://www.target.com/web_checkouts/v1/cart_items',{method:'POST',body:'{}'}).catch(()=>{});
        ` });
        if (route.request().url() !== config.productUrl) return route.abort();
        await route.fulfill({ contentType: 'text/html', body: `<title>${config.productName}</title>
          <header><button>Deliver to 75013</button></header><h1>${config.productName}</h1>
          <section aria-label="Fulfillment"><button id="SHIPPING">Shipping loading...</button></section>
          <script src="${bundleUrl}"></script>` });
      });
      // Only replace the transport destination. The real diagnostic guard,
      // POST forwarding options, browser response, DOM and lifecycle all run.
      const adapter = {
        newPage: () => context.newPage(), request: { get: assert.fail },
        route: (pattern, handler) => context.route(pattern, route => handler({
          request: () => route.request(), abort: (...args) => route.abort(...args),
          fallback: (...args) => route.fallback(...args), fulfill: (...args) => route.fulfill(...args),
          fetch: options => {
            assert.equal(route.request().url(), cdui);
            assert.equal(options.maxRedirects, 0);
            assert.equal(options.maxRetries, 0);
            return context.request.post(localUrl, { ...options, data: route.request().postData() });
          },
        })),
      };
      const events = [];
      assert.equal(await diagnose(adapter, config, { waitMs: 350, emit: value => events.push(value) }), 2);
      assert.deepEqual(serverCalls, ['/enrich']);
      if (fixtureStatus === 200) {
        assert.equal(events.find(e => e.event === 'fulfillment_response').outcome, 'cdui_schema_unverified');
        assert.equal(events.find(e => e.event === 'rendered_shipping').displayedShipping, 'available');
        assert.equal(events.at(-1).cduiPostsForwarded, 1);
      } else if (fixtureStatus === 435) {
        assert.equal(events.find(e => e.event === 'fulfillment_response').outcome, 'challenge');
      } else {
        assert.equal(events.find(e => e.event === 'fulfillment_redirect_blocked').status, 307);
      }
      assert.equal(events.at(-1).directInventoryGetSent, false);
      console.log(`CDUI ${fixtureStatus}: one local data POST; zero cart writes or redirect follows.`);
    } finally { await context.close(); }
  }
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
