// Discovery-only rules. These do not change the live buyer's inventory parser.
import { shippingAvailability } from './safety.mjs';

export const CDUI_PATH = '/cdui_orchestrations/v1/pages/pdp/deferred_enrichment/modules';
const fulfillmentModules = new Set([
  'ProductDetailFulfillment', 'ProductDetailFulfillmentMessaging',
  'ProductDetailWebDatasourceFulfillmentAndVariations',
]);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const onlyKeys = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));

function enrichmentBody(text) {
  if (typeof text !== 'string' || text.length > 500_000) return false;
  let body;
  try { body = JSON.parse(text); } catch { return false; }
  return onlyKeys(body, ['page_context', 'modules']) &&
    typeof body.page_context === 'string' && body.page_context.length > 0 &&
    Array.isArray(body.modules) && body.modules.length > 0 && body.modules.length <= 100 &&
    body.modules.every(module => onlyKeys(module, ['module_type', 'module_placement_id', 'enrichment_context']) &&
      typeof module.module_type === 'string' && /^Product[A-Za-z0-9]{1,100}$/.test(module.module_type) &&
      typeof module.module_placement_id === 'string' && module.module_placement_id.length > 0 &&
      typeof module.enrichment_context === 'string' && module.enrichment_context.length > 0) &&
    body.modules.some(module => fulfillmentModules.has(module.module_type));
}

// No keys, cookies, visitor IDs, opaque contexts, or full query strings leave here.
export function fulfillmentRequest(url, method, postData, config) {
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.hash) return null;
  const cdui = ['www.target.com', 'cdui-orchestrations.target.com'].includes(parsed.hostname) &&
    parsed.pathname === CDUI_PATH && method === 'POST';
  const redsky = parsed.hostname === 'redsky.target.com' && method === 'GET' &&
    /^\/redsky_aggregations\/v1\/web\/pdp_(?:fulfillment|client)_v\d+$/.test(parsed.pathname);
  if (!cdui && !redsky) return null;
  const tcins = parsed.searchParams.getAll('tcin');
  const zips = parsed.searchParams.getAll('zip');
  const productMatches = tcins.length === 1 && tcins[0] === config.tcin;
  const zip = zips.length === 1 && /^\d{5}$/.test(zips[0]) ? zips[0] : null;
  return {
    kind: cdui ? 'cdui' : 'redsky', endpoint: parsed.origin + parsed.pathname, method,
    productMatches, zip, zipMatches: zip === config.zip,
    allowed: productMatches && (zips.length === 0 || (zips.length === 1 && zip !== null)) &&
      (!cdui || enrichmentBody(postData)),
  };
}

export function allowDiagnosticRequest(url, method, postData, config) {
  const candidate = fulfillmentRequest(url, method, postData, config);
  if (candidate) return candidate.allowed;
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  // The product page needs these bundles to hydrate. A file named
  // module-component-product-detail-add-to-cart.js is not a cart operation.
  if (['GET', 'HEAD'].includes(method) && parsed.protocol === 'https:' &&
      parsed.hostname === 'assets.targetimg1.com' && !parsed.username && !parsed.password && !parsed.port &&
      /^\/webui\/top-of-funnel\/_next\/static\/.*\.(?:js|css)$/.test(parsed.pathname)) return true;
  const shopping = /(?:cart|checkout|payment|place[-_]?order)/i.test(parsed.hostname + parsed.pathname);
  return ['GET', 'HEAD', 'OPTIONS'].includes(method) && !shopping;
}

export async function routeDiagnosticRequest(route, config) {
  const request = route.request();
  const url = request.url(), method = request.method(), postData = request.postData();
  const candidate = fulfillmentRequest(url, method, postData, config);
  if (!allowDiagnosticRequest(url, method, postData, config)) {
    await route.abort('blockedbyclient');
    return candidate ? { event: 'fulfillment_request_blocked', ...candidate } : null;
  }
  if (candidate?.kind !== 'cdui') {
    await route.fallback();
    return null;
  }
  // Forward the page's data query once with this context's cookies. A 307/308
  // must not forward this POST to a different endpoint; do not retry failures.
  const response = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: 15000 });
  try {
    const status = response.status();
    if (status >= 300 && status < 400) {
      await route.abort('blockedbyclient');
      return { event: 'fulfillment_redirect_blocked', ...candidate, status };
    }
    await route.fulfill({ response });
    return { event: 'cdui_post_forwarded', ...candidate, status };
  } finally { await response.dispose(); }
}

export function fulfillmentResponse(request, status, body, config) {
  const challenge = object(body) && (typeof body.blockScript === 'string' || typeof body.jsClientSrc === 'string');
  let outcome = challenge ? 'challenge' : [401, 403, 435].includes(status) ? 'declined' :
    status === 429 ? 'rate_limited' : status >= 300 && status < 400 ? 'redirected' :
    status !== 200 ? 'http_error' : !object(body) ? 'invalid_json' :
    !request.productMatches ? 'product_mismatch' : !request.zipMatches ? 'destination_unverified' :
    request.kind === 'cdui' ? 'cdui_schema_unverified' : 'unknown_shipping_schema';
  let shipping = 'unknown';
  if (outcome === 'unknown_shipping_schema') {
    shipping = shippingAvailability(body, config.tcin);
    if (shipping !== 'unknown') outcome = 'recognized_shipping';
  }
  const result = { ...request, status, outcome, shipping };
  // Describe only known fulfillment structure, never arbitrary server strings.
  if (request.kind === 'cdui' && status === 200 && !challenge && object(body)) {
    const sectionCounts = [];
    const stack = [body];
    let visited = 0;
    while (stack.length && ++visited <= 10_000) {
      const node = stack.pop();
      if (Array.isArray(node)) { stack.push(...node.slice(0, 1000)); continue; }
      if (!object(node)) continue;
      if (node.module_type === 'ProductDetailFulfillment') {
        const rows = node.module_data?.data_by_tcin;
        for (const row of Array.isArray(rows) ? rows.slice(0, 100) : []) {
          if (String(row?.tcin) === config.tcin && Array.isArray(row.three_up_sections)) {
            sectionCounts.push(row.three_up_sections.length);
          }
        }
      }
      stack.push(...Object.values(node).filter(value => value && typeof value === 'object').slice(0, 1000));
    }
    result.fulfillmentSectionCounts = sectionCounts.slice(0, 100);
    result.structureScanTruncated = stack.length > 0;
  }
  return result;
}
