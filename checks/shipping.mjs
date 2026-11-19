// Exercise the same browser reader used by npm run check. All pages are local fixtures.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { observeUntilVerified, productSnapshot } from '../src/target.mjs';

const config = JSON.parse(await readFile(new URL('../config.json', import.meta.url)));
const browser = await chromium.launch({ channel: config.channel, headless: true });
try {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  let html;
  await context.route('**/*', route => route.request().isNavigationRequest()
    ? route.fulfill({ status: 200, contentType: 'text/html', body: html })
    : route.abort());

  async function check(label, fields, expected, expectedDisplay = expected) {
    const { title = config.productName, url = config.productUrl, headerZip = '75013',
      pickup = 'Not available', delivery = 'Not available', tile = 'Arrives by Fri, Nov 20',
      detail = '', detailZip = '', selected = true, cart = '', tileClass = '' } = fields;
    html = `<header><button>Deliver to ${headerZip}</button></header>
      <main><h1>${title}</h1><section aria-label="Fulfillment">
      <button>Pickup ${pickup}</button><button>Delivery ${delivery}</button>
      <button id="SHIPPING" class="${tileClass}" aria-label="Shipping, ${selected ? 'selected' : ''}">Shipping <span>${tile}</span></button>
      <div>${detailZip ? 'Ship to ' + detailZip : ''}</div><div>${detail}</div>
      </section>${cart}</main><aside>Only 1 left! <button>Add to cart for another console</button></aside>`;
    await page.goto(url);
    const { shipping, displayedShipping } = await productSnapshot(page, config);
    assert.equal(shipping, expected, label);
    assert.equal(displayedShipping, expectedDisplay, label);
    console.log(label + ' → ' + shipping);
  }
  await check('Pro shows shipping unavailable', { tile: 'Not available' }, 'unavailable');
  await check('Base PS5 example', { title: 'PlayStation 5 Console - Digital Edition', url: 'https://www.target.com/p/example/-/A-94961316' }, 'unknown');
  await check('Pro has an arrival date and both local options are gray', { detailZip: '75013' }, 'available');
  await check('Pro has low shipping stock with no date', { tile: 'Only 1 left' }, 'available');
  await check('Low stock appears below Ship to ZIP', { tile: '', detailZip: '75013', detail: 'Only 1 left' }, 'available');
  await check('Low pickup stock only', { tile: '', pickup: 'Only 1 left', selected: false }, 'unknown');
  await check('Local delivery offered but shipping unavailable', { tile: 'Not available', delivery: 'As soon as 8pm today', cart: '<button>Add to cart PlayStation 5 Pro Console</button>' }, 'unavailable');
  await check('Shipping destination overrides header', { detailZip: '10001' }, 'unknown', 'available');
  await check('Shipping tile has a date but ZIP is missing', { headerZip: '' }, 'unknown', 'available');
  await check('Shipping panel supplies missing header ZIP', { headerZip: '', detailZip: '75013' }, 'available');
  await check('Positive tile but negative shipping details', { detailZip: '75013', detail: 'Out of stock' }, 'unavailable');
  await check('Selected tile has no availability information', { tile: '', cart: '<button>Add to cart PlayStation 5 Pro Console</button>' }, 'unknown');
  await check('Unselected but shippable, with unfamiliar copy and no ZIP', { tile: 'Standard parcel', headerZip: '', selected: false, tileClass: 'styles_notActiveAndAvailableFulfillmentCell__wylMF' }, 'unknown', 'available');
  await check('Selected but unavailable, even with a date', { tileClass: 'styles_activeAndUnavailableFulfillmentCell__XjAi0' }, 'unavailable');
  await check('Loading tile with an availability class', { tile: 'Loading...', tileClass: 'styles_activeAndAvailableFulfillmentCell__test' }, 'unknown');
  const newOffer = { tile: 'Standard parcel', detailZip: '75013', cart: '<button>Add to cart PlayStation 5 Pro Console</button>' };
  await check('Unknown wording with an actionable shipping selection', newOffer, 'possible');
  await check('Wrong destination cannot produce a possible alert', { ...newOffer, detailZip: '10001' }, 'unknown');
  await check('Inactive cart cannot corroborate unfamiliar wording', { ...newOffer, cart: '<button disabled>Add to cart PlayStation 5 Pro Console</button>' }, 'unknown');
  await check('Restock prompt mentions in stock', { ...newOffer, tile: 'Notify me when back in stock' }, 'unknown');
  await check('Shipping restriction overrides an arrival hint', { ...newOffer, tile: 'Ready to ship', detail: 'Cannot ship to your address' }, 'unavailable');
  await check('Relative arrival wording', { tile: 'Get it tomorrow' }, 'available');
  await check('Different low-stock wording', { tile: 'Just 2 units remaining' }, 'available');
  await page.setContent('<main>Verify you are human</main>');
  const waiting = Promise.withResolvers();
  let reads = 0;
  let cleared = 0;
  const observed = observeUntilVerified(page, () => ++reads, {
    signal: AbortSignal.timeout(5000), allowWait: true,
    onWaiting: waiting.resolve, onCleared: () => { cleared++; },
  });
  await waiting.promise;
  assert.equal(reads, 0);
  // Replace the local fixture to represent a user returning to the listing.
  await page.setContent('<main>PlayStation 5 Pro Console</main>');
  assert.equal(await observed, 1);
  assert.equal(cleared, 1);
  await page.setContent('<main>Access denied</main>');
  await assert.rejects(observeUntilVerified(page, () => ++reads, {
    signal: AbortSignal.timeout(2000), allowWait: true,
    onWaiting: assert.fail, onCleared: assert.fail,
  }), /declined access/);
  assert.equal(reads, 1);
  console.log('Human verification wait resumes one read. A plain denial stops it.');
} finally { await browser.close(); }
