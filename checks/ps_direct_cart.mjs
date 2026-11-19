import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {addOne,PRO,sonyAccountState} from '../src/ps_cart.mjs';

const browser = await chromium.launch({channel:'chrome',headless:true,chromiumSandbox:true});
try {
  const page = await browser.newPage();
  const requests = [];
  let count = 0;
  await page.route('**/*', route => {
    requests.push(route.request().method());
    if (route.request().url() !== PRO) return route.abort();
    return route.fulfill({contentType:'text/html; charset=utf-8',body:`<link rel="canonical" href="${PRO}"><h1>PlayStation®5 Pro Console</h1>
      <div itemtype="https://schema.org/Product"><meta itemprop="sku" content="1000050805">
      <div itemtype="http://schema.org/Offer"><link itemprop="availability" href="http://schema.org/InStock"></div>
      <producthero-info><button class="add-to-cart" data-product-code="1000050805" onclick="document.querySelector('.js-mini-cart-count').textContent=String(++window.clicks)">Add</button></producthero-info></div>
      <button class="add-to-cart" data-product-code="other" onclick="throw Error('wrong product')">Add</button>
      <span class="js-mini-cart-count">0</span><script>window.clicks=0</script>`});
  });
  await page.goto(PRO);
  const neverClaim = async () => { throw Error('unverified session must not claim the cart attempt'); };
  assert.equal(await sonyAccountState(page),'unknown');
  assert.equal(await addOne(page,neverClaim),'sign_in_required');
  await page.locator('body').evaluate(el => el.insertAdjacentHTML('afterbegin',
    '<a class="js-topnav-desktop-signin-link">Sign In</a><div class="js-topnav-desktop-profile-icon" hidden>My Account</div><span class="js-profile-menu-username" hidden>Fixture</span>'));
  assert.equal(await sonyAccountState(page),'signed_out');
  assert.equal(await addOne(page,neverClaim),'sign_in_required');
  assert.equal(await page.evaluate(()=>window.clicks),0);
  await page.locator('.js-topnav-desktop-signin-link').evaluate(el => el.hidden = true);
  await page.locator('.js-topnav-desktop-profile-icon').evaluate(el => el.hidden = false);
  assert.equal(await sonyAccountState(page),'signed_in');
  assert.equal(await addOne(page,async()=>{count++;return true;}),'added');
  assert.equal(count,1);
  assert.equal(await page.evaluate(()=>window.clicks),1);
  assert.equal(await addOne(page,async()=>false),'previous_attempt_review_required');
  assert.equal(await page.evaluate(()=>window.clicks),1);
  await page.locator('[itemprop=availability]').evaluate(el=>el.href='https://schema.org/OutOfStock');
  assert.equal(await addOne(page,async()=>{throw Error('unexpected claim');}),'stock_changed');
  assert.deepEqual(requests,['GET']);
  console.log('Local cart tests passed: signed-out and unknown sessions never clicked; verified account added once; stock and duplicate guards passed.');
} finally {await browser.close();}
