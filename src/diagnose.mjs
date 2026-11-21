// One-shot discovery. Only the known product-data POST is allowed; no shopping actions.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { inventoryRequest } from './safety.mjs';
import { productSnapshot } from './target.mjs';
import { fulfillmentRequest, fulfillmentResponse, routeDiagnosticRequest, allowDiagnosticRequest } from './target_discovery.mjs';
import { withTargetSession } from './target_session.mjs';

const products = {
  pro: { tcin: '93620188', productName: 'PlayStation 5 Pro Console', productUrl: 'https://www.target.com/p/playstation-5-pro-console/-/A-93620188' },
  base: { tcin: '94961316', productName: 'PlayStation 5 Console - Digital Edition', productUrl: 'https://www.target.com/p/playstation-5-console-digital-edition/-/A-94961316' },
};

function dependency(request) {
  const host = new URL(request.url()).hostname;
  if (!/(?:^|\.)(?:target\.com|targetimg1\.com)$/.test(host)) return null;
  return { host, method: request.method(), resourceType: request.resourceType() };
}

async function boundedJSON(response) {
  let timer;
  try {
    return await Promise.race([
      response.json().catch(() => null),
      new Promise(resolve => { timer = setTimeout(() => resolve(null), 2000); }),
    ]);
  } finally { clearTimeout(timer); }
}

export async function diagnose(context, config, { waitMs = 20000, emit = console.log } = {}) {
  const page = await context.newPage();
  const terminal = Promise.withResolvers();
  const tasks = new Set();
  let stopped = false, finished = false, stopReason = null, replay = null;
  let matched = 0, cduiPostsForwarded = 0, directInventoryGetSent = false, verified = false;
  let dependencyFailures = 0;
  const blockedDependencies = new Set();
  const log = (event, detail = {}) => {
    if (!finished) emit({ event, observedAt: new Date().toISOString(), tcin: config.tcin, requestedZip: config.zip, ...detail });
  };
  const stop = reason => {
    stopped = true;
    if (!stopReason || stopReason === 'target_http_error') stopReason = reason;
    terminal.resolve();
  };
  const routeHandler = async route => {
    if (stopped || finished) return route.abort('blockedbyclient');
    try {
      const result = await routeDiagnosticRequest(route, config);
      if (!result) {
        const req = route.request();
        const detail = dependency(req);
        if (detail && !allowDiagnosticRequest(req.url(), req.method(), req.postData(), config)) {
          const key = JSON.stringify(detail);
          if (!blockedDependencies.has(key)) {
            blockedDependencies.add(key);
            log('request_blocked_by_diagnostic', detail);
          }
        }
      }
      if (result) {
        log(result.event, result);
        if (result.event === 'cdui_post_forwarded') cduiPostsForwarded++;
        if (result.event === 'fulfillment_redirect_blocked') stop('redirected');
      }
    } catch {
      const req = route.request();
      const candidate = fulfillmentRequest(req.url(), req.method(), req.postData(), config);
      if (candidate) { log('fulfillment_request_failed', candidate); stop('request_failed'); }
      await route.abort('failed').catch(() => {});
    }
  };
  const onResponse = response => {
    const req = response.request();
    const candidate = fulfillmentRequest(response.url(), req.method(), req.postData(), config);
    if (finished) return;
    if (!candidate?.allowed) {
      const detail = dependency(req);
      const status = response.status();
      if (detail && status >= 400) {
        dependencyFailures++;
        log('page_dependency_http_error', { ...detail, status });
        if ([401, 403, 435, 429].includes(status)) stop('dependency_declined');
      }
      return;
    }
    matched++;
    const status = response.status();
    if (status >= 300) stop('target_http_error');
    const task = (async () => {
      const result = fulfillmentResponse(candidate, status, await boundedJSON(response), config);
      log('fulfillment_response', { ...result, transport: candidate.kind === 'cdui' ? 'http_forward' : 'browser' });
      if (['challenge', 'declined', 'rate_limited', 'redirected', 'http_error'].includes(result.outcome)) stop(result.outcome);
      if (result.outcome === 'recognized_shipping' && inventoryRequest(response.url(), req.method(), config)) replay = response.url();
    })();
    tasks.add(task);
    task.then(() => tasks.delete(task), () => { tasks.delete(task); stop('response_read_failed'); });
  };
  const onFailed = req => {
    const candidate = fulfillmentRequest(req.url(), req.method(), req.postData(), config);
    if (candidate?.allowed && !stopped && !finished) {
      log('fulfillment_request_failed', candidate);
      stop('request_failed');
    } else if (!candidate && !stopped && !finished) {
      const detail = dependency(req);
      if (detail && allowDiagnosticRequest(req.url(), req.method(), req.postData(), config)) {
        dependencyFailures++;
        const error = req.failure()?.errorText;
        log('page_dependency_failed', { ...detail, kind: /^net::ERR_[A-Z0-9_]+$/.test(error) ? error : 'network_error' });
      }
    }
  };
  const onPageError = error => log('page_script_error', { kind: ['TypeError', 'ReferenceError', 'SyntaxError', 'RangeError'].includes(error.name) ? error.name : 'Error' });
  await context.route('**/*', routeHandler);
  page.on('response', onResponse);
  page.on('requestfailed', onFailed);
  page.on('pageerror', onPageError);
  try {
    const start = performance.now();
    try {
      const response = await page.goto(config.productUrl, { waitUntil: 'domcontentloaded', timeout: config.navigationTimeoutMs });
      log('product_page', { status: response?.status(), elapsedMs: Math.round(performance.now() - start) });
      if (!response || response.status() !== 200) stop('listing_unverified');
    } catch (error) {
      log('navigation_interrupted', { kind: error.name });
      stop('navigation_failed');
    }
    let timer;
    try {
      await Promise.race([terminal.promise, new Promise(resolve => { timer = setTimeout(resolve, waitMs); })]);
    } finally { clearTimeout(timer); }
    await Promise.allSettled([...tasks]);
    try {
      const snapshot = await productSnapshot(page, config);
      log('rendered_shipping', {
        correctProduct: snapshot.correctProduct, shipping: snapshot.shipping,
        displayedShipping: snapshot.displayedShipping, destinationZip: snapshot.destinationZip,
        zipMatches: snapshot.zipMatches,
      });
    } catch { log('rendered_shipping', { shipping: 'unknown', outcome: 'unreadable_or_verification' }); }
    if (replay && !stopped) {
      directInventoryGetSent = true;
      const response = await context.request.get(replay, {
        headers: { Accept: 'application/json', Referer: config.productUrl },
        maxRedirects: 0, maxRetries: 0, timeout: 15000,
      });
      try {
        const result = fulfillmentResponse(fulfillmentRequest(replay, 'GET', null, config), response.status(), await boundedJSON(response), config);
        verified = result.outcome === 'recognized_shipping';
        log('direct_inventory_get', result);
        if (['challenge', 'declined', 'rate_limited', 'redirected', 'http_error'].includes(result.outcome)) stop(result.outcome);
      } finally { await response.dispose(); }
    }
    log('diagnostic_complete', {
      outcome: verified ? 'http_shipping_verified' : stopReason ?? (matched ? 'http_shipping_unverified' : 'no_matching_fulfillment_request'),
      directInventoryGetSent, cduiPostsForwarded, dependencyFailures, blockedDependencyGroups: blockedDependencies.size,
    });
    return verified ? 0 : 2;
  } finally {
    finished = true;
    page.off('response', onResponse);
    page.off('requestfailed', onFailed);
    page.off('pageerror', onPageError);
    // Keep the request guard installed until the caller closes this context.
    await page.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('node src/diagnose.mjs [--model pro|base|both] [--zip 75013] [--session] [--headed] [--channel chrome|chromium]');
    return;
  }
  let model = 'pro', zip, headed = false, channel, session = false;
  for (let i = 0; i < args.length; i++) {
    if (['--model', '--zip', '--channel'].includes(args[i]) && (!args[i + 1] || args[i + 1].startsWith('--'))) {
      throw new Error('Missing diagnostic argument value. Use --help.');
    }
    if (args[i] === '--model') model = args[++i];
    else if (args[i] === '--zip') zip = args[++i];
    else if (args[i] === '--channel') channel = args[++i];
    else if (args[i] === '--headed') headed = true;
    else if (args[i] === '--session') session = true;
    else throw new Error('Unknown diagnostic argument. Use --help.');
  }
  let defaults = JSON.parse(await readFile(new URL('../config.json', import.meta.url)));
  try { defaults = { ...defaults, ...JSON.parse(await readFile(new URL('../config.local.json', import.meta.url))) }; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  zip ??= defaults.zip;
  channel ??= defaults.channel;
  if (!['pro', 'base', 'both'].includes(model) || !/^\d{5}$/.test(zip) || !['chrome', 'chromium'].includes(channel)) {
    throw new Error('Invalid model, ZIP, or browser channel. Use --help.');
  }
  const { chromium } = await import('playwright');
  const launchOptions = { channel: channel === 'chromium' ? undefined : channel, headless: !headed };
  const browser = session ? null : await chromium.launch(launchOptions);
  try {
    for (const selected of model === 'both' ? ['base', 'pro'] : [model]) {
      let declined = false;
      const run = async context => {
        const code = await diagnose(context, { ...defaults, ...products[selected], zip }, { emit: value => {
          console.log(JSON.stringify(value));
          if (['challenge', 'declined', 'rate_limited', 'dependency_declined'].includes(value.outcome)) declined = true;
        } });
        process.exitCode = Math.max(process.exitCode ?? 0, code);
      };
      if (session) {
        await withTargetSession(chromium, { ...launchOptions, serviceWorkers: 'block' }, run);
      } else {
        const context = await browser.newContext({ serviceWorkers: 'block' });
        try { await run(context); } finally { await context.close(); }
      }
      if (declined) break;
    }
  } finally { await browser?.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(JSON.stringify({ event: 'probe_failed', kind: error.name }));
    process.exitCode = 1;
  });
}
