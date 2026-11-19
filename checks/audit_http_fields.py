"""Compare storefront fields in two saved public listing responses, offline."""
import argparse
import hashlib
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from shipping_http import PRODUCTS, parse_listing, shipping_from_nodes

# Only the public product record and shopper-facing parts of the page are in scope.
MODULES = {
    "ProductDetailAvailabilitySneakPeek", "ProductDetailFulfillment", "ProductDetailFulfillmentMessaging",
    "ProductDetailWebDatasourceFulfillmentAndVariations", "ProductDetailAddToCart",
    "ProductDetailPrice", "ProductDetailTitle", "ProductDetailDeals", "ProductDetailPromo",
    "ProductDetailAccordion", "ProductDetailAtAGlance", "ProductDetailBreadcrumbs",
    "ProductDetailImageGallery", "ProductDetailRatingsAndReviews", "ProductAddOns",
    "ProductDetailPriceMatchAndStoreInfo", "ProductDetailFinance", "ProductOrnament",
    "ProductDetailManufacturerNotes", "ProductDetailManufacturerNotesJumpLinks",
}
SKIP = re.compile(r"token|cookie|credential|secret|visitor|metadata|tracking|impression|pixel|experiment|session|analytics|account|username|email|author|review_text|store_location|address", re.I)
READABLE = {
    "tcin", "display", "code", "availability_status", "availability", "stock_status", "title",
    "ornament", "product_type_name", "po_box_prohibited_message", "purchase_behavior"
}

OFFER_PROPERTIES = """
availability availabilityStarts availabilityEnds availableDeliveryMethod inventoryLevel
eligibleQuantity eligibleRegion ineligibleRegion shippingDetails shippingDestination
doesNotShip shippingRate deliveryTime deliveryLeadTime handlingTime transitTime
cutoffTime businessDays deliveryMethod shippingOrigin addressCountry postalCode
""".split()


def offer_markup(nodes):
    """Check commerce properties in JSON-LD, Microdata and RDFa on the public page."""
    observed = defaultdict(set)
    for n in nodes:
        for attr, syntax in (("itemprop", "microdata"), ("property", "RDFa")):
            for token in (n.attrs.get(attr) or "").split():
                observed[token.rsplit("/", 1)[-1].rsplit(":", 1)[-1]].add(syntax)
        if n.tag != "script" or (n.attrs.get("type") or "").lower() != "application/ld+json":
            continue
        try:
            stack = [json.loads("".join(n.children))]
        except (ValueError, TypeError):
            continue
        while stack:
            obj = stack.pop()
            if isinstance(obj, list):
                stack.extend(obj)
            elif isinstance(obj, dict):
                for key in obj:
                    observed[key.rsplit("/", 1)[-1].rsplit(":", 1)[-1]].add("JSON-LD")
                stack.extend(obj.values())
    return {f"pagewide.offerMarkup.{key}": observed.get(key, {"not found"}) for key in OFFER_PROPERTIES}


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def describe(value, leaf):
    if value is None or isinstance(value, (bool, float, int)):
        return json.dumps(value)
    if leaf in READABLE and len(value) <= 80 and '://' not in value and '@' not in value:
        return json.dumps(value, ensure_ascii=False)
    return f"text({len(value)} chars, sha256 {digest(value)[:12]})"


def fields(nodes, sku):
    result = defaultdict(set)
    result.update(offer_markup(nodes))

    def flatten(value, path, leaf):
        if isinstance(value, dict):
            if not value:
                result[path].add("{}")
            for key, item in value.items():
                if not SKIP.search(key) and re.fullmatch(r"[A-Za-z_][A-Za-z_0-9.-]{0,85}", key):
                    flatten(item, f"{path}.{key}", key)
        elif isinstance(value, list):
            if not value:
                result[path].add("[]")
            for item in value:
                flatten(item, path + "[*]", leaf)
        else:
            result[path].add(describe(value, leaf))

    for n in nodes:
        if n.tag == "script" and n.attrs.get("type") == "application/json":
            stack = [json.loads("".join(n.children))]
            while stack:
                obj = stack.pop()
                if isinstance(obj, list):
                    stack.extend(obj)
                if not isinstance(obj, dict):
                    continue
                stack.extend(obj.values())
                if str(obj.get("tcin")) == sku and isinstance(obj.get("item"), dict):
                    flatten(obj, "product", "")
                name = obj.get("module_type")
                if name in MODULES:
                    flatten(obj.get("module_data"), "modules." + name, "")
        elif n.tag == "meta":
            prop = n.attrs.get("property") or n.attrs.get("itemprop") or n.attrs.get("name") or ""
            if prop.startswith(("product:", "og:")) or prop in {"availability", "price", "priceCurrency"}:
                result["markup.meta." + prop].add(describe(n.attrs.get("content") or "", prop))
        elif n.attrs.get("aria-label") == "Fulfillment":
            for control in n.walk():
                key = control.attrs.get("id")
                if control.tag == "button" and key in {"SHIPPING", "PICKUP", "DELIVERY", "SCHEDULED_DELIVERY", "ORDER_PICKUP"}:
                    for attr in ("aria-label", "disabled", "aria-disabled", "aria-pressed", "class"):
                        result[f"markup.fulfillment.{key}.{attr}"].add(str(control.attrs[attr]) if attr in control.attrs else "(absent)")
                    result[f"markup.fulfillment.{key}.text"].add(control.text()[:120])
        elif n.tag == "button" and n.text().strip().lower() in {"add to cart", "buy now", "notify me", "unsubscribe"}:
            control = n.text().strip().lower()
            result[f"markup.purchaseButton.{control}.disabled"].add(str("disabled" in n.attrs or n.attrs.get("aria-disabled") == "true"))
    return result


def compact(values):
    if values is None:
        return {"present": False}
    sorted_values = sorted(values)
    report = {"present": True, "distinctValues": len(values), "sample": sorted_values[:3]}
    if len(values) > 3:
        report["setSHA256"] = digest(json.dumps(sorted_values))
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for model in ("base", "pro"):
        parser.add_argument("--" + model, type=Path, required=True)
    args = parser.parse_args()
    captures, by_model = {}, {}
    for model in ("base", "pro"):
        data = getattr(args, model).read_bytes()
        nodes = parse_listing(data.decode("utf-8"))
        shipping, reason = shipping_from_nodes(nodes, model, None)
        if reason == "Response did not identify the expected product":
            parser.error(f"Wrong product or missing identity for {model}")
        by_model[model] = fields(nodes, PRODUCTS[model][0])
        captures[model] = {"tcin": PRODUCTS[model][0], "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(),
                           "shipping": shipping, "reason": reason}
    base, pro = by_model["base"], by_model["pro"]
    rows = []
    for key in sorted(set(base) | set(pro)):
        left, right = base.get(key), pro.get(key)
        if left is None:
            comparison = "Pro only"
        elif right is None:
            comparison = "base only"
        else:
            comparison = "same" if left == right else "different"
        rows.append({"id": len(rows) + 1, "field": key, "comparison": comparison, "base": compact(left), "pro": compact(right)})
    print(json.dumps({"scope": "Distinct public product fields, selected primary product modules, social metadata and fulfillment controls. Array positions are pooled; repeated renderings of the same field count once. Storefront text outside a small allowlist is fingerprinted.",
                      "captures": captures, "count": len(rows), "fields": rows}, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
