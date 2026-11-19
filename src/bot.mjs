// Target's standalone CLI owns its Playwright context and filesystem locks.
// The Chrome extension has a separate state machine and a separate CVV handler.
import { chromium } from 'playwright';
import { readFile, mkdir, chmod } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { RunState, assertSafeToBuy } from './state.mjs';
import { validateConfig, inventoryRequest, shippingAvailability, retryDelay, checkoutProblems, nextPollDelay } from './safety.mjs';
import { NeedsAttention, observeUntilVerified, shippingName, chooseShipping, checkBlockers, productSnapshot, validateProduct, addOne, goToCheckout, checkoutSnapshot, submitOrder, waitForConfirmation } from './target.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = new Set(process.argv.slice(2));
for (const arg of args) if (!['--setup', '--once', '--http-check', '--buy', '--help'].includes(arg)) throw new Error(`Unknown argument: ${arg}`);
if (args.has('--help')) {
  console.log('npm run setup: sign in and select ZIP\nnpm run check: one read-only stock check\nnpm start: monitor only\nnpm run buy: monitor, add one console, and submit once within the configured all-in limit');
  console.log('npm run check:http: browserless public listing check\nnpm run check:session: one read-only HTTP inventory test using the dedicated session');
  process.exit(0);
}
if (args.size > 1) throw new Error('Choose only one mode.');
let config = JSON.parse(await readFile(path.join(root, 'config.json'), 'utf8'));
try { config = { ...config, ...JSON.parse(await readFile(path.join(root, 'config.local.json'), 'utf8')) }; }
catch (error) { if (error.code !== 'ENOENT') throw error; }
validateConfig(config);
const runtime = path.join(root, '.runtime');
const state = new RunState(runtime);
const abort = new AbortController();
let context;
let mutating = false;
const log = (event, detail = {}) => console.log(JSON.stringify({ time: new Date().toISOString(), event, ...detail }));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => abort.abort());
const pause = ms => sleep(ms, null, { signal: abort.signal });

function observe(page, read) {
  return observeUntilVerified(page, read, {
    signal: abort.signal,
    allowWait: !config.headless && !mutating,
    onWaiting() {
      log('waiting_for_you', { message: 'Complete the visible verification in the dedicated Chrome window. Stock requests are paused.' });
      process.stdout.write('\u0007');
    },
    onCleared() { log('verification_cleared'); },
  });
}

async function navigate(page) {
  await page.goto(config.productUrl, { waitUntil: 'domcontentloaded' });
  const title = page.getByRole('heading', { name: config.productName, exact: true, level: 1 });
  const tile = page.getByRole('button', { name: shippingName });
  // Count time spent loading controls, excluding time spent on human verification.
  let remaining = config.navigationTimeoutMs;
  while (remaining > 0) {
    const ready = await observe(page, async () => await title.isVisible() && await tile.isVisible());
    if (ready) return;
    await pause(250);
    remaining -= 250;
  }
  throw new NeedsAttention('The product and shipping controls did not load in the dedicated session.');
}

async function buy(page) {
  // A positive signal already refreshed this listing. Recheck after selecting shipping.
  await chooseShipping(page);
  const product = await productSnapshot(page, config);
  validateProduct(product, config);
  if (product.shipping !== 'available' || !product.shippingSelected || !product.available) return false;
  if (abort.signal.aborted) return false;
  mutating = true;
  await state.write({ phase: 'adding', tcin: config.tcin });
  await addOne(page, config);
  await state.write({ phase: 'cart', tcin: config.tcin });
  if (abort.signal.aborted) throw new NeedsAttention('Stopped with the item in the cart.');
  await goToCheckout(page, config);
  await state.write({ phase: 'checkout', tcin: config.tcin });
  await checkBlockers(page);
  let snapshot = await checkoutSnapshot(page);
  let issues = checkoutProblems(snapshot, config);
  if (!snapshot.placeOrderEnabled) issues.push('Place order is not enabled.');
  if (issues.length) throw new NeedsAttention(issues.join(' '));
  // Re-read immediately; do not approve a price from a previous page state.
  snapshot = await checkoutSnapshot(page);
  issues = checkoutProblems(snapshot, config);
  if (issues.length || !snapshot.placeOrderEnabled) throw new NeedsAttention(issues.join(' ') || 'Checkout changed.');
  if (abort.signal.aborted) throw new NeedsAttention('Stopped before order submission.');
  await state.write({ phase: 'submitting', tcin: config.tcin, totalCents: snapshot.totalCents });
  log('submitting_once', { total: snapshot.totalCents / 100 });
  await submitOrder(page);
  await state.write({ phase: 'submitted', tcin: config.tcin, totalCents: snapshot.totalCents });
  await waitForConfirmation(page);
  await state.write({ phase: 'confirmed', tcin: config.tcin, totalCents: snapshot.totalCents });
  log('order_confirmed', { total: snapshot.totalCents / 100 });
  process.stdout.write('\u0007');
  return true;
}

async function main() {
  await state.acquire();
  if (args.has('--buy')) assertSafeToBuy(await state.read());
  await mkdir(path.join(runtime, 'browser'), { recursive: true, mode: 0o700 });
  await chmod(runtime, 0o700);
  context = await chromium.launchPersistentContext(path.join(runtime, 'browser'), {
    channel: config.channel || undefined,
    headless: config.headless,
    viewport: { width: 1440, height: 1000 },
  });
  context.setDefaultTimeout(15000);
  context.setDefaultNavigationTimeout(config.navigationTimeoutMs);
  context.on('close', () => abort.abort());
  const page = context.pages()[0] || await context.newPage();
  let inventory = null;
  let inventoryObservedAt = 0;
  let rateLimitedUntil = 0;
  let denied = false;
  let matchedInventory = false;
  const backoffBase = Math.max(30, config.pollSeconds, config.browserPollSeconds);
  page.on('response', async response => {
    try {
      const isInventory = inventoryRequest(response.url(), response.request().method(), config);
      if (isInventory) matchedInventory = true;
      if (!isInventory && response.url() !== config.productUrl) return;
      if ([401, 403, 435].includes(response.status())) {
        denied = true;
        inventory = null;
        return;
      }
      if (response.status() === 429 || response.status() >= 500) {
        rateLimitedUntil = Math.max(rateLimitedUntil, Date.now() + retryDelay(1, backoffBase, response.headers()['retry-after']));
        inventory = null;
        return;
      }
      if (!isInventory || response.status() !== 200) return;
      const body = await response.json();
      if (shippingAvailability(body, config.tcin) === 'unknown') return;
      inventory = { url: response.url(), headers: { Accept: 'application/json', Referer: config.productUrl } };
      inventoryObservedAt = Date.now();
    } catch { /* Unrecognized responses are ignored; browser checks remain available. */ }
  });

  if (args.has('--http-check')) {
    await page.goto(config.productUrl, { waitUntil: 'domcontentloaded' });
    // Observe normal page traffic, including while Target determines the destination.
    for (let i = 0; i < 60; i++) {
      await observe(page, async () => {});
      if (inventory || denied || rateLimitedUntil > Date.now()) break;
      await pause(250);
    }
    if (denied || rateLimitedUntil > Date.now()) throw new NeedsAttention('Target declined or rate-limited the request. HTTP inventory is unverified.');
    if (!inventory) {
      const snapshot = await observe(page, () => productSnapshot(page, config));
      log('http_check_unverified', { reason: matchedInventory ? 'No recognized shipping response' : 'No matching inventory GET on the page', destinationShown: snapshot.destinationZip, requestedZip: config.zip, directRequestSent: false });
      process.exitCode = 2;
      return;
    }
    const start = performance.now();
    const response = await context.request.get(inventory.url, { headers: inventory.headers, timeout: 20000, maxRedirects: 0, maxRetries: 0 });
    try {
      const shipping = response.status() === 200 ? shippingAvailability(await response.json().catch(() => null), config.tcin) : 'unknown';
      log('http_check_result', { status: response.status(), shipping, zip: config.zip, durationMs: Math.round(performance.now() - start) });
      if (shipping === 'unknown') process.exitCode = 2;
    } finally { await response.dispose(); }
    return;
  }

  if (args.has('--setup')) {
    await page.goto(config.productUrl, { waitUntil: 'domcontentloaded' });
    console.log('\nIn the opened browser: sign in to Target, set delivery ZIP 75013, select Shipping, and leave the cart empty. Set up your saved address/payment directly on Target. No order will be placed in setup mode.');
    if (!process.stdin.isTTY) throw new NeedsAttention('Run npm run setup in an interactive terminal to save your session.');
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try { await prompt.question('After setup, return to this terminal and press Enter: ', { signal: abort.signal }); }
    finally { prompt.close(); }
    await navigate(page);
    const snapshot = await productSnapshot(page, config);
    validateProduct(snapshot, config);
    log('setup_saved', { zip: config.zip, shipping: snapshot.shipping });
    return;
  }

  const buying = args.has('--buy');
  const stockField = buying ? 'shipping' : 'displayedShipping';
  log('starting', { mode: buying ? 'automatic-purchase' : 'read-only', maxTotal: config.maxTotal, zip: buying ? config.zip : undefined, pollSeconds: config.pollSeconds, browserPollSeconds: config.browserPollSeconds });
  let lastNavigation = 0;
  let failures = 0;
  let lastShipping;
  while (!abort.signal.aborted) {
    try {
      if (Date.now() < rateLimitedUntil) {
        log('backoff', { seconds: Math.ceil((rateLimitedUntil - Date.now()) / 1000) });
        await pause(rateLimitedUntil - Date.now());
      }
      await observe(page, async () => {});
      if (denied) throw new NeedsAttention('Target declined a listing or inventory request.');
      const started = performance.now();
      let shipping = 'unknown';
      let destinationZip = config.zip;
      let displayedShipping;
      let source = 'browser';
      // A periodic browser refresh re-establishes the session and API request.
      if (inventory && Date.now() - lastNavigation < config.browserRefreshSeconds * 1000 && Date.now() - inventoryObservedAt < 600000) {
        const response = await context.request.get(inventory.url, { headers: inventory.headers, timeout: 20000, maxRedirects: 0 });
        try {
          const status = response.status();
          if ([401, 403, 435].includes(status)) throw new NeedsAttention('Target declined the inventory request.');
          if (status === 429 || status >= 500) {
            rateLimitedUntil = Date.now() + retryDelay(failures + 1, backoffBase, response.headers()['retry-after']);
            throw new Error(`Inventory returned HTTP ${status}; backing off.`);
          }
          if (status !== 200) inventory = null;
          else {
            const stock = shippingAvailability(await response.json(), config.tcin);
            if (stock === 'unknown') inventory = null;
            else { shipping = stock; source = 'http'; }
          }
        } finally { await response.dispose(); }
      }
      if (source === 'browser' || shipping === 'available') {
        source = 'browser';
        await navigate(page);
        lastNavigation = Date.now();
        if (denied) throw new NeedsAttention('Target declined a listing or inventory request.');
        if (Date.now() < rateLimitedUntil) throw new Error('Target asked the monitor to back off.');
        let snapshot = await observe(page, () => productSnapshot(page, config));
        // The tile can render before its destination and arrival estimate.
        const readyUntil = performance.now() + 4000;
        while (snapshot.correctProduct && snapshot[stockField] === 'unknown' && performance.now() < readyUntil) {
          if (buying && snapshot.destinationZip && !snapshot.zipMatches) break;
          await pause(250);
          snapshot = await observe(page, () => productSnapshot(page, config));
        }
        if (!snapshot.correctProduct) throw new NeedsAttention('Cannot verify the PS5 Pro listing.');
        shipping = snapshot[stockField];
        displayedShipping = snapshot.displayedShipping;
        destinationZip = snapshot.destinationZip;
      }
      log('stock', { source, shipping, displayedShipping, destinationZip, requestedZip: buying ? config.zip : undefined, durationMs: Math.round(performance.now() - started) });
      failures = 0;
      if (shipping === 'possible' && lastShipping !== 'possible') {
        process.stdout.write('\u0007');
        log('possible_shipping_alert', { message: 'Shipping is selected for your ZIP and the console cart button is enabled. Check the unfamiliar shipping offer on Target.' });
      }
      lastShipping = shipping;
      if (shipping === 'available') {
        process.stdout.write('\u0007');
        if (args.has('--buy')) {
          if (await buy(page)) return;
          log('stock_changed_before_cart');
        } else log('stock_alert', { message: 'Read-only mode: no cart or checkout action taken.' });
      }
      if (args.has('--once')) return;
      const interval = inventory ? config.pollSeconds : config.browserPollSeconds;
      await pause(nextPollDelay(interval, performance.now() - started));
    } catch (error) {
      if (error.name === 'AbortError') return;
      if (denied && !mutating) throw new NeedsAttention('Target declined a listing or inventory request.');
      if (mutating || error instanceof NeedsAttention) throw error;
      log('read_error', { kind: error.name, message: 'Read-only check failed; retrying with backoff.' });
      if (args.has('--once')) throw new NeedsAttention('Stock check failed. Run setup and check the browser.');
      if (++failures >= 5) throw new NeedsAttention('Five consecutive read failures. Check the session before restarting.');
      await pause(Math.max(retryDelay(failures, backoffBase), rateLimitedUntil - Date.now()));
    }
  }
}

try { await main(); }
catch (error) {
  if (error.name !== 'AbortError') {
    // Do not print Playwright request errors, which can include credential-bearing URLs.
    let reason = 'Browser observation failed.';
    if (/closed|crashed|detached/i.test(error.message)) reason = 'The browser, page or frame closed before the check completed.';
    if (/execution context was destroyed/i.test(error.message)) reason = 'Target navigated while its page was being read.';
    if (error.name === 'TimeoutError') reason = 'The browser operation timed out.';
    if (error instanceof NeedsAttention || !context) reason = error.message;
    log('stopped', { reason, kind: error.name, mutationAttempted: mutating });
    if (mutating) {
      const previous = await state.read();
      await state.write({ ...previous, phase: previous.phase === 'confirmed' ? 'confirmed' : 'needs-review', stoppedAt: previous.phase });
    }
    process.stdout.write('\u0007');
    process.exitCode = 1;
  }
} finally {
  // Context close flushes the dedicated login profile. It does not touch normal Chrome profiles.
  await context?.close().catch(() => {});
  await state.release();
}
