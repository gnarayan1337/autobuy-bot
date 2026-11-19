// Browser adapter for bot.mjs. Snapshot functions read shopper-visible evidence.
// The CLI reserves mutations in RunState before calling the action functions.
import { setTimeout as sleep } from 'node:timers/promises';
import { cents } from './safety.mjs';

export class NeedsAttention extends Error {}
export class VerificationRequired extends NeedsAttention {}

// Exclude the separate product-details button and the initial loading skeleton.
export const shippingName = /^Shipping(?!\s*(?:&|and)\s*Returns)(?!.*loading)(?:\s|,|$)/i;

const shippingUnavailable = /\b(?:unavailable|not available|not ready to ship|not in stock|out of stock|sold out|(?:cannot|can['’]t) (?:be shipped|ship)|does(?:n't|n’t| not) ship|not (?:eligible|available) for shipping|0 (?:left|remaining))\b/i;
const shippingPending = /\b(?:loading|check availability|pre[- ]?order|back[- ]?order(?:ed)?|waitlist|notify me|back in stock|when available|coming soon)\b/i;
const shippingOffer = /\b(?:arrives? (?:by|on|in|tomorrow|today)|get it (?:by|on|tomorrow|today)|ships? (?:by|tomorrow|today|in \d+)|ready to ship|available (?:for shipping|to ship)|in stock|(?:only\s*)?[1-9]\d*\s+(?:(?:units?|items?|consoles?)\s+)?(?:left|remaining))\b/i;

export async function checkBlockers(page) {
  const blocked = await page.evaluate(() => {
    const visible = el => !!(el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
    const text = document.body?.innerText || '';
    if (/verify (?:that )?you are human|press and hold/i.test(text) ||
        [...document.querySelectorAll('iframe[src*="captcha"], [id*="captcha"]')].some(visible)) return 'captcha';
    if (/access denied|unusual traffic|temporarily blocked/i.test(text)) return 'Target declined access.';
    if ([...document.querySelectorAll('input[type="password"], input[autocomplete="one-time-code"]')].some(visible)) return 'Target requires login or verification.';
    return null;
  });
  if (blocked === 'captcha') throw new VerificationRequired('Target is asking for human verification.');
  if (blocked) throw new NeedsAttention(blocked);
}

// Retry only local, read-only observations after the user clears a challenge.
// Navigation, HTTP requests, and cart/checkout actions never run in this loop.
export async function observeUntilVerified(page, read, { signal, allowWait, onWaiting, onCleared }) {
  const pause = ms => sleep(ms, null, { signal });
  let waiting = false;
  while (true) {
    signal.throwIfAborted();
    try {
      await checkBlockers(page);
      const result = await read();
      if (waiting) onCleared();
      return result;
    } catch (error) {
      if (waiting && /execution context was destroyed/i.test(error.message) && !page.isClosed()) {
        await pause(250);
        continue;
      }
      if (!(error instanceof VerificationRequired) || !allowWait) throw error;
      if (!waiting) {
        onWaiting();
        waiting = true;
      }
      await pause(1000);
    }
  }
}

export async function chooseShipping(page) {
  const shipping = page.getByRole('button', { name: shippingName });
  if (await shipping.count() !== 1) throw new NeedsAttention('Cannot uniquely identify the shipping option.');
  const selected = await shipping.evaluate(el => ['aria-pressed', 'aria-checked', 'aria-selected'].some(attr => el.getAttribute(attr) === 'true') || /(?:^|,)\s*selected\b/i.test(el.getAttribute('aria-label') || ''));
  if (!selected && await shipping.isEnabled()) await shipping.click();
}

export async function productSnapshot(page, config) {
  await checkBlockers(page);
  const snapshot = await page.evaluate(({ productName, tcin, zip, shippingPattern }) => {
    const norm = text => (text || '').replace(/\s+/g, ' ').trim();
    const visible = el => !!(el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
    const name = el => norm(el.getAttribute('aria-label') || el.innerText);
    const buttons = [...document.querySelectorAll('button')].filter(visible);
    const add = buttons.filter(el => new RegExp(`^Add to cart(?: for)? ${productName}$`, 'i').test(name(el)));
    const headings = [...document.querySelectorAll('h1')].filter(el => visible(el) && norm(el.innerText) === productName);
    const cart = [...document.querySelectorAll('a[href*="/cart"]')].filter(visible).map(name).join(' ');
    const cartMatch = cart.match(/cart\s+(\d+)\s+items?/i);
    const shipButtons = buttons.filter(el => new RegExp(shippingPattern, 'i').test(name(el)));
    const tile = shipButtons.length === 1 ? shipButtons[0] : null;
    const tileText = tile ? norm([name(tile), tile.innerText].join(' ')) : '';
    const selected = !!tile && (['aria-checked', 'aria-pressed', 'aria-selected'].some(attr => tile.getAttribute(attr) === 'true') || /(?:^|,)\s*selected\b/i.test(name(tile)));
    const region = tile?.closest('[aria-label="Fulfillment" i], [data-test="fulfillment"]');
    const controlled = document.getElementById(tile?.getAttribute('aria-controls') || '');
    let details = '';
    if (controlled && visible(controlled)) {
      details = norm(controlled.innerText);
    } else if (tile) {
      // Read the detail panel after all three options. Pickup and delivery tile
      // copy must never become evidence for shipping.
      const scope = region || tile.closest('#info-and-fulfillment');
      const end = add.length === 1 ? add[0] : null;
      if (scope || end) {
        const range = document.createRange();
        if (scope) range.selectNodeContents(scope);
        const options = buttons.filter(el => {
          if (el === tile) return true;
          if (!/^(?:pickup|delivery)\b/i.test(name(el))) return false;
          return scope ? scope.contains(el) : el.parentElement === tile.parentElement;
        });
        range.setStartAfter(options.at(-1));
        if (end && (!scope || scope.contains(end))) range.setEndBefore(end);
        // Use visible text nodes only. Do not inspect a recommendation carousel
        // or any alternative item's stock if Target changes the layout.
        const walker = document.createTreeWalker(range.commonAncestorContainer, NodeFilter.SHOW_TEXT);
        const parts = [];
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (!range.intersectsNode(node) || !node.parentElement || !visible(node.parentElement)) continue;
          if (node.parentElement.closest('button, a, script, style, [hidden], [aria-hidden="true"]')) continue;
          parts.push(node.textContent);
        }
        details = norm(parts.join(' '));
      }
    }
    const panelDestinations = [...new Set([...details.matchAll(/\bship to\s*:?\s*(\d{5})\b/ig)].map(match => match[1]))];
    const headerControls = [...document.querySelectorAll('button, [role="button"], header a')].filter(visible);
    const headerDestinations = headerControls.flatMap(el => [name(el), norm(el.innerText)])
      .map(text => text.match(/^(?:deliver|ship) to(?: location)?\s*:?\s*(\d{5})\b/i)?.[1]).filter(Boolean);
    const destinations = panelDestinations.length ? panelDestinations : [...new Set(headerDestinations)];
    const explicitPanel = details.search(/\bship to\s*:?\s*\d{5}\b/i);
    const shipPanel = explicitPanel >= 0 || (selected && !!region) || (controlled && visible(controlled));
    const priceNodes = [...document.querySelectorAll('[data-test="product-price"]')].filter(visible);
    let price = priceNodes.length === 1 ? norm(priceNodes[0].innerText) : null;
    // If Target changes its price marker, only inspect the title-to-cart section.
    if (!price && headings.length === 1 && add.length === 1) {
      const range = document.createRange();
      try {
        range.setStartAfter(headings[0]); range.setEndBefore(add[0]);
        const prices = range.toString().match(/\$[\d,]+\.\d{2}/g) || [];
        if (prices.length === 1) price = prices[0];
      } catch { /* The page has not finished rendering. */ }
    }
    return {
      correctProduct: locationOrigin() && new RegExp(`/A-${tcin}(?:[/?#]|$)`).test(locationHref()) && headings.length === 1,
      available: add.length === 1 && !add[0].disabled && add[0].getAttribute('aria-disabled') !== 'true',
      buttonFound: add.length === 1,
      tileClasses: tile?.id === 'SHIPPING' ? Array.from(tile.classList) : [],
      tileText, detailText: shipPanel ? details.slice(Math.max(0, explicitPanel)) : '',
      shippingSelected: selected || panelDestinations.length === 1,
      selectedForDestination: selected && panelDestinations.length === 1 && panelDestinations[0] === zip,
      tileDisabled: !!tile && (tile.disabled || tile.getAttribute('aria-disabled') === 'true'),
      zipMatches: destinations.length === 1 && destinations[0] === zip,
      destinationZip: destinations.length === 1 ? destinations[0] : null,
      cartCount: cartMatch ? Number(cartMatch[1]) : null,
      price,
      checkedExtras: [...document.querySelectorAll('input[type="checkbox"]:checked, [role="checkbox"][aria-checked="true"]')].filter(visible).length,
    };
    function locationOrigin() { return window.location.origin === 'https://www.target.com'; }
    function locationHref() { return window.location.href; }
  }, { ...config, shippingPattern: shippingName.source });
  const { tileClasses, tileText, detailText, tileDisabled, ...result } = snapshot;
  const copy = [tileText, detailText].join(' ');
  const tileStates = tileClasses.map(c => /^styles_(?:active|notActive)And(Available|Unavailable)FulfillmentCell__/.exec(c)?.[1]);
  let displayedShipping = 'unknown';
  if (result.correctProduct && tileText && !/\bloading\b/i.test(tileText)) {
    if (tileStates.includes('Unavailable') || shippingUnavailable.test(copy)) displayedShipping = 'unavailable';
    else if (!tileDisabled && !shippingPending.test(copy)) {
      if (tileStates.includes('Available') || shippingOffer.test(copy)) displayedShipping = 'available';
      // A selected shipping option, its destination, and a working item button
      // merit an alert even if the shipping copy changes. Only "available" can buy.
      else if (result.selectedForDestination && result.available) displayedShipping = 'possible';
    }
  }
  return { ...result, displayedShipping, shipping: result.zipMatches ? displayedShipping : 'unknown' };
}

export function validateProduct(snapshot, config) {
  if (!snapshot.correctProduct) throw new NeedsAttention('The exact PS5 Pro product page could not be verified.');
  if (!snapshot.zipMatches) throw new NeedsAttention(`Set Target's delivery ZIP to ${config.zip} before starting.`);
  if (snapshot.cartCount !== 0) throw new NeedsAttention('Target cart must be visibly empty before automatic add-to-cart.');
  if (snapshot.checkedExtras !== 0) throw new NeedsAttention('Uncheck optional services before starting.');
  const price = cents(snapshot.price);
  if (price === null || price > cents(config.maxTotal)) throw new NeedsAttention('Product price is unknown or above the total limit.');
}

export async function addOne(page, config) {
  const snapshot = await productSnapshot(page, config);
  validateProduct(snapshot, config);
  if (snapshot.shipping !== 'available' || !snapshot.shippingSelected || !snapshot.available) throw new NeedsAttention('Shipping and the console cart button must both be ready.');
  await page.getByRole('button', { name: /^Add to cart(?: for)? PlayStation 5 Pro Console$/i }).click({ timeout: 10000 });
  // Require acknowledgement before any navigation; never retry the mutation.
  await page.waitForFunction(() => {
    const visible = el => !!el.getClientRects().length;
    return [...document.querySelectorAll('a[href*="/cart"]')].filter(visible).some(el => /cart\s+1\s+items?/i.test(el.getAttribute('aria-label') || el.innerText)) ||
      [...document.querySelectorAll('[role="dialog"], [role="status"]')].filter(visible).some(el => /added to (?:your )?cart/i.test(el.innerText));
  }, null, { timeout: 15000 });
  await page.goto('https://www.target.com/cart', { waitUntil: 'domcontentloaded' });
}

export async function goToCheckout(page, config) {
  await checkBlockers(page);
  const button = page.getByRole('button', { name: /^(?:I'm ready to check out|Check out|Checkout)$/i });
  await button.waitFor({ state: 'visible', timeout: config.checkoutTimeoutMs });
  // This only opens checkout, never submits an order.
  await button.click();
  await page.getByRole('button', { name: /^(?:Place (?:your )?order|Place order and pay)$/i }).waitFor({ state: 'visible', timeout: config.checkoutTimeoutMs });
}

// Conservative, independent checkout evidence. Missing fields stop the purchase.
// Target markup varies by account. Selectors are deliberately centralized here.
export async function checkoutSnapshot(page) {
  const raw = await page.evaluate(() => {
    const norm = value => (value || '').replace(/\s+/g, ' ').trim();
    const visible = el => !!(el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
    const all = selector => [...document.querySelectorAll(selector)].filter(visible);
    const name = el => norm(el.getAttribute('aria-label') || el.innerText);
    const exactLabelBlock = regex => {
      const labels = all('h1,h2,h3,h4,span,div,p,dt').filter(el => regex.test(norm(el.innerText)));
      for (const label of labels) {
        for (let node = label.parentElement, depth = 0; node && depth < 3; node = node.parentElement, depth++) {
          const value = norm(node.innerText);
          if (value.length < 700 && value.length > norm(label.innerText).length) return value;
        }
      }
      return '';
    };
    const finalButtons = all('button').filter(el => /^(?:Place (?:your )?order|Place order and pay)$/i.test(name(el)));
    const totals = [];
    for (const label of all('span,div,p,dt,strong')) {
      if (!/^(?:Order total|Total)$/i.test(norm(label.innerText))) continue;
      let node = label.parentElement;
      for (let depth = 0; node && depth < 3; node = node.parentElement, depth++) {
        const text = norm(node.innerText);
        const prices = text.match(/\$[\d,]+\.\d{2}/g) || [];
        if (prices.length === 1 && text.length < 150) { totals.push(prices[0]); break; }
      }
    }
    const summary = all('[data-test="cartItem"], [data-test="cart-item"], [data-test="checkout-item"], [data-test="order-item"]');
    // Fallback: identify each product's smallest container with an explicit quantity.
    let items = summary;
    if (!items.length) {
      const candidates = [];
      for (const link of all('a[href*="/A-"]')) {
        for (let node = link.parentElement, depth = 0; node && depth < 6; node = node.parentElement, depth++) {
          const text = norm(node.innerText);
          const ids = new Set([...node.querySelectorAll('a[href*="/A-"]')].map(el => el.href.match(/\/A-(\d+)/)?.[1]));
          if (ids.size === 1 && /(?:Qty|Quantity)\s*:?\s*\d+/i.test(text) && text.length < 2000) { candidates.push(node); break; }
        }
      }
      items = [...new Set(candidates)].filter(node => !candidates.some(other => other !== node && node.contains(other)));
    }
    const itemText = items.length === 1 ? norm(items[0].innerText) : '';
    const itemIds = items.length === 1 ? [...new Set([...items[0].querySelectorAll('a[href*="/A-"]')].map(el => el.href.match(/\/A-(\d+)/)?.[1]))] : [];
    const quantity = itemText.match(/(?:Qty|Quantity)\s*:?\s*(\d+)/i);
    const address = exactLabelBlock(/^(?:Shipping address|Ship to|Deliver to)$/i);
    const payment = exactLabelBlock(/^(?:Payment|Payment method)$/i);
    const orderText = all('main,[role="main"]').map(el => norm(el.innerText)).join(' ') || norm(document.body.innerText);
    const itemCountLabels = [...orderText.matchAll(/(?:Order summary|Your order|Cart)\s*\(?(\d+)\s+items?\)?/gi)].map(match => Number(match[1]));
    const countConfirmed = itemCountLabels.length > 0 && itemCountLabels.every(count => count === items.length);
    const shippingEvidence = /\b(?:Shipping|Ships? to|Shipping delivery)\b/i.test(itemText) || /\b(?:Shipping|Ships? to)\b/i.test(address);
    return {
      trustedCheckout: window.location.origin === 'https://www.target.com' && /^\/(?:checkout(?:\/|$)|co-(?:review|checkout|payment|delivery)(?:\/|$))/.test(window.location.pathname),
      itemCount: countConfirmed ? items.length : null,
      tcin: itemIds.length === 1 ? itemIds[0] : null,
      quantity: quantity ? Number(quantity[1]) : null,
      fulfillment: shippingEvidence && !/\b(?:Pickup|Drive up|Same day delivery)\b/i.test(itemText) ? 'shipping' : null,
      zip: address.match(/\b(\d{5})(?:-\d{4})?\b/)?.[1] || null,
      seller: /(?:Sold (?:and|&) shipped by|Sold by)\s*Target\b/i.test(itemText) ? 'Target' : null,
      addons: items.length && countConfirmed ? /(?:Protection plan|Allstate|subscription|membership|Target Circle 360)/i.test(itemText) : null,
      paymentReady: /(?:ending in|\*{4}|•{4}|Visa|Mastercard|American Express|Discover|Circle Card|Target Card)/i.test(payment) && !/enter|add payment|verify|security code/i.test(payment),
      total: [...new Set(totals)].length === 1 ? totals[0] : null,
      placeOrderEnabled: finalButtons.length === 1 && !finalButtons[0].disabled && finalButtons[0].getAttribute('aria-disabled') !== 'true',
    };
  });
  return { ...raw, totalCents: cents(raw.total) };
}

export async function submitOrder(page) {
  await page.getByRole('button', { name: /^(?:Place (?:your )?order|Place order and pay)$/i }).click({ timeout: 10000 });
}

export async function waitForConfirmation(page) {
  await page.waitForFunction(() => {
    const text = document.body.innerText;
    return /(?:thanks|thank you) for (?:your order|shopping)|your order is confirmed|order placed/i.test(text) && /order (?:number|#)/i.test(text);
  }, null, { timeout: 45000 });
  return true;
}
