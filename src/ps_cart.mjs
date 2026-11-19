// Optional browser handoff after the independent HTTPS watcher confirms InStock.
import { chromium } from 'playwright';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

export const PRO = 'https://direct.playstation.com/en-us/buy-consoles/playstation5-pro-console';
const SKU = '1000050805';
const BASE = 'https://direct.playstation.com/en-us/buy-consoles/playstation5-console-1-tb';
const MODELS = {
  pro: {url:PRO, sku:SKU, title:'PlayStation®5 Pro Console'},
  base: {url:BASE, sku:'1000049888', title:'PlayStation®5 Console - 1 TB'},
};
const WORK = fileURLToPath(new URL('../.runtime/ps-direct/', import.meta.url));
const addedDialog = /added to (?:your )?(?:shopping )?cart/i;

export async function sonyAccountState(page) {
  const url = new URL(page.url());
  if (url.origin !== new URL(PRO).origin) {
    return url.protocol === 'https:' && /(^|\.)account\.sony\.com$/.test(url.hostname) ? 'sign_in_page' : 'unknown';
  }
  return page.evaluate(() => {
    if (location.origin !== 'https://direct.playstation.com') return 'unknown';
    const visible = el => el.getClientRects().length > 0 && getComputedStyle(el).visibility === 'visible';
    const shown = selector => [...document.querySelectorAll(selector)].some(visible);
    if (shown('.js-topnav-desktop-signin-link, .js-topnav-mobile-signin-link')) return 'signed_out';
    if (shown('.js-topnav-desktop-signout-link, .js-topnav-mobile-signout-link')) return 'signed_in';
    const accountNav = shown('.js-topnav-desktop-profile-icon, .js-topnav-mobile-signedin-wrapper');
    const namedProfile = !!document.querySelector('.js-profile-menu-username')?.textContent.trim();
    return accountNav && namedProfile ? 'signed_in' : 'unknown';
  }).catch(() => 'unknown');
}

export async function addOne(page, claim, model='pro') {
  const {url, sku, title} = MODELS[model];
  if (page.url() !== url) return 'unexpected_page';
  const product = page.locator('[itemtype$="schema.org/Product"]').filter({
    has: page.locator('meta[itemprop="sku"][content="' + sku + '"]'),
  });
  await product.waitFor({timeout: 15000});
  if (await page.locator('link[rel="canonical"]').getAttribute('href') !== url ||
      (await page.locator('h1').innerText()).replace(/\s+/g, ' ').trim() !== title) return 'unexpected_product';

  // Limit the click to the primary product hero. The same document lists accessories
  // and also contains hidden duplicate Add controls for the sticky toolbar.
  const button = product.locator('producthero-info button.add-to-cart[data-product-code="' + sku + '"]:visible');
  try { await button.waitFor({state: 'visible', timeout: 12000}); }
  catch { return 'add_control_not_ready'; }
  const availability = await product.locator('[itemtype$="schema.org/Offer"] [itemprop="availability"]').evaluateAll(
    els => els.map(el => el.getAttribute('href') || el.getAttribute('content')),
  );
  if (!availability.length || !availability.every(v => /^https?:\/\/schema\.org\/InStock$/.test(v))) return 'stock_changed';
  if (!(await button.isEnabled()) || page.url() !== url) return 'add_control_not_ready';
  const count = await page.locator('.js-mini-cart-count:visible').allTextContents();
  const before = count.length === 1 && /^\d+$/.test(count[0].trim()) ? Number(count[0]) : null;
  if (await sonyAccountState(page) !== 'signed_in') return 'sign_in_required';
  if (!await claim()) return 'previous_attempt_review_required';
  try {
    await button.click({timeout: 3500});
    await page.waitForFunction(({before, dialogPattern, title}) => {
      const visible = el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
      const counts = [...document.querySelectorAll('.js-mini-cart-count')].filter(visible);
      if (before !== null && counts.length === 1 && counts[0].textContent.trim() === String(before + 1)) return true;
      return [...document.querySelectorAll('[role="dialog"], [role="status"], [role="alert"]')].filter(visible)
        .some(el => new RegExp(dialogPattern,'i').test(el.innerText) && el.innerText.replace(/®|\s/g, '').toLowerCase().includes(title.replace(/®|\s/g, '').toLowerCase()));
    }, {before, dialogPattern: addedDialog.source, title}, {timeout: 12000});
    return 'added';
  } catch { return 'attempt_unconfirmed_review_cart'; }
}

async function inspectBaseCart(ctx) {
  const file = path.join(WORK,'base-cart-review.json');
  let info = {at:new Date().toISOString(), result:'unverified', sku:MODELS.base.sku};
  try {
    const cart = await ctx.newPage();
    await cart.goto('https://direct.playstation.com/en-us/checkout?tab=cart', {waitUntil:'domcontentloaded',timeout:30000});
    await cart.bringToFront();
    // Wait for a cart result or the store's verification/sign-in UI; do not click anything.
    for (let i=0; i<20; i++) {
      if (new URL(cart.url()).origin !== new URL(BASE).origin) {
        info = {...info,result:'redirected', destinationHost:new URL(cart.url()).hostname};
        break;
      }
      const view = await cart.evaluate(({sku,title}) => {
        const visible = e => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
        const text = document.body?.innerText || '';
        const clean = v => v.replace(/[®™]/g,'').replace(/\s+/g,' ').trim().toLowerCase();
        const empty = /(?:your (?:shopping )?(?:cart|basket) is (?:currently )?empty|(?:no|0) items in your (?:shopping )?cart|your cart is looking empty)/i.test(text);
        const hasSignIn = [...document.querySelectorAll('a,button')].some(e=>visible(e)&&/^sign in$/i.test(e.innerText.trim()));
        const signedOutOnly = /sign in to (?:see|view|access) your (?:shopping )?cart/i.test(text);
        const item = [...document.querySelectorAll('[data-product-code], a[href], [class*="cart-item"], [class*="cartItem"]')].filter(visible).some(el => {
          if (el.closest('[class*="recommend" i], [class*="carousel" i]')) return false;
          const row = el.closest('[class*="cart-item" i], [class*="line-item" i], [class*="cartentry" i], [class*="cart-product" i], [class*="cartItem"]');
          if (!row || !visible(row)) return false;
          return row.getAttribute('data-product-code')===sku || clean(row.innerText).includes(clean(title));
        });
        const counts = [...document.querySelectorAll('.js-mini-cart-count')].filter(visible).map(e=>e.textContent.trim()).filter(v=>/^\d+$/.test(v));
        return {item, empty, hasSignIn, signedOutOnly, counts,
          verification:/verify (?:that )?you are human|unusual traffic|access denied|press and hold/i.test(text),
          cartHeading:[...document.querySelectorAll('h1,h2')].some(e=>visible(e)&&/^(?:(?:your|shopping) )?cart(?:\s*\(\d+\))?$/i.test(e.innerText.trim()))};
      },MODELS.base);
      info = {...info, ...view, result:view.verification?'verification_required':view.signedOutOnly?'sign_in_required':view.item&&!view.empty?'base_in_cart':view.empty&&!view.item?'empty':'unverified'};
      if (info.result!=='unverified') break;
      await new Promise(resolve=>setTimeout(resolve,500));
    }
  } catch(error) { info.kind=error.name; }
  await writeFile(file + '.tmp',JSON.stringify(info),{mode:0o600});
  await rename(file + '.tmp',file);
}

async function baseTrial(ctx) {
  const file = path.join(WORK, 'base-test.json');
  const record = {sku: MODELS.base.sku, profile: path.join(WORK,'cart-profile'), at:new Date().toISOString()};
  const save = async fields => {
    Object.assign(record, fields);
    await writeFile(file + '.tmp', JSON.stringify(record), {mode:0o600});
    await rename(file + '.tmp', file);
  };
  await save({result:'opening_base_page'});
  try {
    const page = await ctx.newPage();
    await page.goto(BASE, {waitUntil:'domcontentloaded',timeout:30000});
    await page.bringToFront();
    const signIn = page.getByRole('link',{name:/^sign in$/i}).first();
    const signInVisible = await signIn.waitFor({state:'visible',timeout:5000}).then(()=>true,()=>false);
    await save({signInPromptVisible:signInVisible, result:'checking_add_button'});
    const result = await addOne(page, async () => {
      try {
        await writeFile(path.join(WORK,'base-test-attempt.json'),JSON.stringify({sku:MODELS.base.sku,at:new Date().toISOString()}),{flag:'wx',mode:0o600});
        return true;
      } catch (e) { if(e.code==='EEXIST') return false; throw e; }
    }, 'base');
    await save({result});
    if (result === 'added' || result === 'attempt_unconfirmed_review_cart') {
      // Read only the cart drawer / rendered acknowledgement, without entering checkout.
      const evidence = await page.evaluate(() => {
        const visible = e => e.getClientRects().length && getComputedStyle(e).visibility!=='hidden';
        const text = document.body.innerText;
        return {addedMessage:/added to (?:your )?(?:shopping )?cart/i.test(text),
          counts:[...document.querySelectorAll('.js-mini-cart-count')].filter(visible).map(e=>e.textContent.trim()).filter(v=>/^\d+$/.test(v)),
          cartLinkVisible:[...document.querySelectorAll('a,button')].some(e=>visible(e)&&/^(?:view|go to) (?:your )?cart$/i.test(e.innerText.trim())),
          itemAlreadyPresent:/already (?:in|added to) (?:your )?cart/i.test(text)};
      });
      await save({evidence});
    }
  } catch (error) { await save({result:'needs_manual_review',kind:error.name}); }
}

async function main() {
  const state = path.join(WORK, 'cart-state.json');
  await mkdir(WORK, {recursive:true, mode:0o700});
  async function save(phase, fields = {}) {
    await writeFile(state + '.tmp', JSON.stringify({phase, at:new Date().toISOString(), ...fields}), {mode:0o600});
    await rename(state + '.tmp', state);
  }
  const lines = createInterface({input:process.stdin, terminal:false});
  const signal = new Promise(resolve => {
    lines.once('line', line => resolve(line === 'add-one' ? 'add-one' : 'stop'));
    lines.once('close', () => resolve('stop'));
  });
  const launch = () => chromium.launchPersistentContext(path.join(WORK, 'cart-profile'), {
    channel:'chrome', headless:false, chromiumSandbox:true,
  });
  let ctx;
  let timer;
  let observation;
  let lastState;
  let lastSaved = 0;
  async function observeAccount() {
    const pages = (ctx?.pages() || []).filter(p => !p.isClosed()).reverse();
    let page;
    for (const candidate of pages) {
      if (await candidate.evaluate(() => document.visibilityState === 'visible').catch(() => false)) {
        page = candidate;
        break;
      }
    }
    const state = page ? await sonyAccountState(page) : 'unknown';
    if (state !== lastState || Date.now() - lastSaved >= 30000) {
      await save(state === 'signed_in' ? 'waiting_for_stock' : 'waiting_for_verified_sign_in',
                 {accountState:state, cartReady:state === 'signed_in'});
      lastState = state;
      lastSaved = Date.now();
    }
  }
  try {
    ctx = await launch();
    const tab = ctx.pages()[0] || await ctx.newPage();
    await tab.goto(PRO,{waitUntil:'domcontentloaded',timeout:30000});
    const signIn = tab.locator('a.js-topnav-desktop-signin-link:visible, a.js-topnav-mobile-signin-link:visible').first();
    const signInVisible = await signIn.waitFor({state:'visible', timeout:4000}).then(() => true, () => false);
    await observeAccount();
    if (signInVisible && process.env.PS_DIRECT_OPEN_SIGNIN === 'once') {
      const href = new URL(await signIn.getAttribute('href'), PRO);
      if (href.origin === 'https://ca.account.sony.com') {
        await tab.bringToFront();
        await signIn.click({timeout: 5000}).catch(() => {});
      }
    }
    timer = setInterval(() => {
      if (!observation) observation = observeAccount().catch(() => {}).finally(() => { observation = undefined; });
    }, 3000);
    if (process.env.PS_DIRECT_BASE_TRIAL === 'inspect') void inspectBaseCart(ctx).catch(()=>console.error('Cart read-back requires manual review.'));
    if (process.env.PS_DIRECT_BASE_TRIAL === 'once') {
      void baseTrial(ctx).catch(() => console.error('Base test requires manual review.'));
    }
  } catch {
    // The HTTP watch remains independent even if Chrome was unavailable during setup.
    await save('browser_setup_unavailable');
    await ctx?.close().catch(() => {});
    ctx = undefined;
  }
  const action = await signal;
  clearInterval(timer);
  await observation;
  if (action === 'stop') {
    await ctx?.close().catch(() => {});
    await save('stopped');
    return;
  }
  await save('checking_pro_add_button');
  try {
    if (!ctx || ctx.isClosed()) ctx = await launch();
    // Preserve the user's sign-in tab. This new tab shares the dedicated profile.
    const page = await ctx.newPage();
    await page.goto(PRO, {waitUntil:'domcontentloaded',timeout:30000});
    await page.bringToFront();
    const result = await addOne(page, async () => {
      try {
        await writeFile(path.join(WORK,'cart-attempt.json'), JSON.stringify({sku:SKU, at:new Date().toISOString()}), {flag:'wx',mode:0o600});
        return true;
      } catch (error) {
        if (error.code === 'EEXIST') return false;
        throw error;
      }
    });
    await save(result);
  } catch {
    await save('needs_manual_review');
  }
  // Leave the cart or any sign-in prompt visible for the user. No checkout actions.
  if (ctx && !ctx.isClosed()) await ctx.waitForEvent('close',{timeout:0}).catch(() => {});
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(() => { console.error('Sony cart helper stopped. Check the dedicated Chrome window.'); process.exitCode = 1; });
}
