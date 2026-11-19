// One-shot, read-only HTTP inventory test. The probe has no purchase actions.
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { inventoryRequest, shippingAvailability, validateConfig } from './safety.mjs';

const config = JSON.parse(await readFile(new URL('../config.json', import.meta.url)));
validateConfig(config);
const browser = await chromium.launch({ channel: config.channel, headless: true });
try {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.route('**/*', route => {
    const req = route.request();
    const url = new URL(req.url());
    const shopping = /(?:cart|checkout|payment|place[-_]?order)/i.test(url.hostname + url.pathname);
    return ['GET', 'HEAD', 'OPTIONS'].includes(req.method()) && !shopping ? route.continue() : route.abort();
  });

  const page = await context.newPage();
  const observed = Promise.withResolvers();
  let blocked = false;
  let matched = false;
  page.on('response', async response => {
    const url = new URL(response.url());
    const candidate = inventoryRequest(response.url(), response.request().method(), config);
    if (!candidate && response.url() !== config.productUrl) return;
    const status = response.status();
    if (status >= 400) {
      blocked = true;
      observed.resolve({ outcome: 'target_http_error', path: url.pathname, status });
      return;
    }
    if (!candidate || status !== 200) return;
    matched = true;
    try {
      const availability = shippingAvailability(await response.json(), config.tcin);
      if (availability !== 'unknown') observed.resolve({ url: response.url() });
    } catch { /* Wait for another page response until the observation deadline. */ }
  });

  const started = performance.now();
  const response = await page.goto(config.productUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  console.log(JSON.stringify({ event: 'product_page', status: response?.status(), elapsedMs: Math.round(performance.now() - started) }));
  const timer = setTimeout(() => observed.resolve({ outcome: matched ? 'unknown_shipping_schema' : 'no_matching_inventory_request' }), 20000);
  let result;
  try { result = await observed.promise; } finally { clearTimeout(timer); }
  if (result.url && !blocked) {
    const start = performance.now();
    const direct = await context.request.get(result.url, {
      headers: { Accept: 'application/json', Referer: config.productUrl },
      maxRedirects: 0, maxRetries: 0, timeout: 15000,
    });
    try {
      let availability = 'unknown';
      if (direct.status() === 200) {
        try { availability = shippingAvailability(await direct.json(), config.tcin); } catch {}
      }
      console.log(JSON.stringify({ event: 'direct_inventory_get', status: direct.status(), availability, tcin: config.tcin, zip: config.zip, elapsedMs: Math.round(performance.now() - start) }));
      if (availability === 'unknown') process.exitCode = 2;
    } finally { await direct.dispose(); }
  } else {
    console.log(JSON.stringify({ event: 'inventory_unverified', outcome: result.outcome ?? 'target_http_error', status: result.status, path: result.path, tcin: config.tcin, zip: config.zip, directInventorySent: false }));
    process.exitCode = 2;
  }
} catch (error) {
  console.error(JSON.stringify({ event: 'probe_failed', kind: error.name }));
  process.exitCode = 1;
} finally { await browser.close(); }
