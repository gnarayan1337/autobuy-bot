import { TARGET_ORDER } from '../extension/target-shipping/checkout.js';

export const normalize = value => String(value ?? '').replace(/\s+/g, ' ').trim();

export function cents(value) {
  const text = String(value).replace(/^\$/, '').replaceAll(',', '').trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(result) ? result : null;
}

export function validateConfig(config) {
  if (config.productUrl !== 'https://www.target.com/p/playstation-5-pro-console/-/A-93620188' || config.tcin !== '93620188') {
    throw new Error('This bot is scoped to Target product 93620188.');
  }
  if (config.fulfillment !== 'shipping') throw new Error('Only shipping is implemented.');
  if (!/^\d{5}$/.test(config.zip)) throw new Error('A five-digit shipping ZIP is required.');
  if (cents(config.maxTotal) === null || cents(config.maxTotal) <= 0 || cents(config.maxTotal) > TARGET_ORDER.maxCents) {
    throw new Error('Maximum total must be positive and no more than the authorized $1,100.');
  }
  for (const key of ['pollSeconds', 'browserPollSeconds', 'browserRefreshSeconds', 'navigationTimeoutMs', 'checkoutTimeoutMs']) {
    if (!Number.isFinite(config[key]) || config[key] <= 0) throw new Error(`Invalid ${key}.`);
  }
  if (config.pollSeconds < 1 || config.browserPollSeconds < 1) throw new Error('Polling intervals must be at least one second.');
  return config;
}

// Unknown or changed schemas are never interpreted as stock.
export function shippingAvailability(body, tcin) {
  const product = body?.data?.product;
  if (String(product?.tcin) !== tcin) return 'unknown';
  const status = product.fulfillment?.shipping_options?.availability_status;
  if (status === 'IN_STOCK') return 'available';
  if (['OUT_OF_STOCK', 'UNAVAILABLE', 'NOT_SOLD_ONLINE'].includes(status)) return 'unavailable';
  return 'unknown';
}

// Replay only inventory GETs actually observed in this browser session.
export function inventoryRequest(url, method, config) {
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  return method === 'GET' && parsed.protocol === 'https:' &&
    parsed.hostname === 'redsky.target.com' &&
    /\/pdp_(?:fulfillment|client)_v\d+$/.test(parsed.pathname) &&
    parsed.searchParams.get('tcin') === config.tcin &&
    parsed.searchParams.get('zip') === config.zip;
}

export function checkoutProblems(snapshot, config) {
  const issues = [];
  if (snapshot.trustedCheckout !== true) issues.push('Not on a verified Target checkout page.');
  if (snapshot.itemCount !== 1) issues.push('Order must contain exactly one item.');
  if (snapshot.tcin !== config.tcin) issues.push('The order product could not be verified.');
  if (snapshot.quantity !== 1) issues.push('Quantity must be exactly one.');
  if (snapshot.fulfillment !== 'shipping') issues.push('Shipping fulfillment could not be verified.');
  if (snapshot.zip !== config.zip) issues.push('Shipping ZIP does not match.');
  if (snapshot.seller !== 'Target') issues.push('Seller must be Target.');
  if (snapshot.addons !== false) issues.push('An extra service, plan, or subscription is present or unverified.');
  if (snapshot.paymentReady !== true) issues.push('Saved payment is not ready.');
  if (snapshot.totalCents === null || !Number.isSafeInteger(snapshot.totalCents) || snapshot.totalCents <= 0) {
    issues.push('Final order total could not be verified.');
  } else if (snapshot.totalCents > cents(config.maxTotal)) {
    issues.push('Final order total exceeds the authorized limit.');
  }
  return issues;
}

export function retryDelay(attempt, baseSeconds, retryAfter, now = Date.now()) {
  const seconds = Number(retryAfter);
  const headerMs = retryAfter && Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter || '') - now;
  return Math.max(baseSeconds * 1000, Math.min(900000, baseSeconds * 1000 * 2 ** Math.min(attempt, 5)), Number.isFinite(headerMs) ? headerMs : 0);
}

// Schedule from request start. Skip missed slots when a request runs long.
export function nextPollDelay(intervalSeconds, elapsedMs) {
  const period = intervalSeconds * 1000;
  return Math.max(1, Math.ceil(elapsedMs / period)) * period - elapsedMs;
}
