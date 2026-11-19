"""Read the shipping offer published in a Target product's HTTP response."""
import argparse
import json
import re
import sys
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlsplit
from urllib.request import Request, build_opener

from storefront_html import Document, Element, NoRedirect, parse_listing

PRODUCTS = {
    "pro": ("93620188", "playstation-5-pro-console", "PlayStation 5 Pro Console"),
    "base": ("94961316", "playstation-5-console-digital-edition", "PlayStation 5 Console - Digital Edition"),
}



def listing(model):
    sku, slug, _ = PRODUCTS[model]
    return f"https://www.target.com/p/{slug}/-/A-{sku}"


def shipping_from_html(html, model, zip_code=None):
    return shipping_from_nodes(parse_listing(html), model, zip_code)


def shipping_controls(nodes):
    regions = [n for n in nodes if (n.attrs.get("aria-label") or "").lower() == "fulfillment" or
               n.attrs.get("data-test") == "module-product-detail-fulfillment-v1"]
    if len(regions) != 1:
        return None, None
    region = regions[0]
    tiles = [n for n in region.walk() if n.tag == "button" and
             (n.attrs.get("id") == "SHIPPING" or re.match(r"^shipping\b", n.attrs.get("aria-label") or n.text(), re.I))]
    return region, tiles[0] if len(tiles) == 1 else None


def shipping_from_nodes(nodes, model, zip_code):
    """Return (shipping state, evidence) for the primary item in a saved response.

    A ZIP restricts the acceptable destination. Loading takes precedence over
    the tile's initial classes, which also appear on the shippable base model.
    """
    product = PRODUCTS[model]
    canonical = [n.attrs.get("href") for n in nodes if n.tag == "link" and n.attrs.get("rel") == "canonical"]
    headings = [n.text() for n in nodes if n.tag == "h1"]
    if canonical != [listing(model)] or headings != [product[2]]:
        return "unknown", "Response did not identify the expected product"

    region, tile = shipping_controls(nodes)
    if region is None:
        return "unknown", "Missing or ambiguous fulfillment section"
    if tile is None:
        return "unknown", "Missing or ambiguous shipping tile"
    copy = f"{tile.attrs.get('aria-label') or ''} {tile.text()}".strip()
    if re.search(r"\bloading\b", copy, re.I):
        return "unknown", f"Shipping tile is a loading placeholder ({copy[:80]})"

    # Local pickup and same-day delivery labels are separate buttons in this region.
    detail = region.text(omit_buttons=True)
    panels = list(re.finditer(r"\bship to\s*:?\s*(\d{5})\b", detail, re.I))
    if panels:
        destinations = {m.group(1) for m in panels}
        copy += " " + detail[panels[0].end():]
    elif zip_code is not None:
        destinations = set()
        for n in nodes:
            if n.tag != "button":
                continue
            m = re.fullmatch(r"(?:deliver|ship) to(?: location)?\s*:?\s*(\d{5})", n.attrs.get("aria-label") or n.text(), re.I)
            if m:
                destinations.add(m.group(1))
    if panels and len(destinations) > 1:
        return "unknown", "Conflicting shipping destinations in response"
    if zip_code is not None and destinations != {zip_code}:
        return "unknown", "No unique matching shipping destination in response"
    tile_states = set()
    if tile.attrs.get("id") == "SHIPPING":
        tile_states = set(re.findall(r"(?:^|\s)styles_(?:active|notActive)And(Available|Unavailable)FulfillmentCell__", tile.attrs.get("class") or ""))
    if "Unavailable" in tile_states or re.search(r"\b(?:not available|unavailable|out of stock|not in stock|sold out|cannot (?:be shipped|ship)|not eligible for shipping)\b", copy, re.I):
        return "unavailable", "Listing marks shipping unavailable"
    if ("disabled" in tile.attrs or tile.attrs.get("aria-disabled") == "true" or
            re.search(r"\b(?:not|cannot|pre[- ]?order|back[- ]?order|back in stock|when available|notify|waitlist)\b", copy, re.I)):
        return "unknown", "Shipping offer is disabled, conditional, or ambiguous"
    if "Available" in tile_states:
        return "available", "Shipping control is marked available"
    if re.search(r"\b(?:(?:arrives?|get it) (?:by|on|tomorrow|today)|ready to ship|available (?:for shipping|to ship)|in stock|[1-9]\d* (?:units? )?(?:left|remaining))\b", copy, re.I):
        return "available", "Listing shows a current shipping offer"
    return "unknown", "No explicit shipping offer"


def catalog_evidence(html, model):
    return catalog_from_nodes(parse_listing(html), model)


def catalog_from_nodes(nodes, model):
    """Read only SKU-specific catalog attributes. None of these decides stock."""
    sku = PRODUCTS[model][0]
    values = {key: set() for key in ("shipToGuestActive", "fastSelling", "fulfillmentSections")}
    for node in nodes:
        if node.tag != "script" or node.attrs.get("type") != "application/json":
            continue
        try:
            stack = [json.loads("".join(node.children))]
        except (ValueError, TypeError, RecursionError):
            continue
        while stack:
            obj = stack.pop()
            if isinstance(obj, list):
                stack.extend(obj)
            if not isinstance(obj, dict):
                continue
            stack.extend(obj.values())
            if str(obj.get("tcin", "")) == sku and isinstance(obj.get("item"), dict):
                for field, path in (
                    ("shipToGuestActive", ("item", "eligibility_rules", "ship_to_guest", "is_active")),
                    ("fastSelling", ("fast_selling", "fast_selling")),
                ):
                    value = obj
                    for key in path:
                        value = value.get(key) if isinstance(value, dict) else None
                    if isinstance(value, bool):
                        values[field].add(value)
            if obj.get("module_type") == "ProductDetailFulfillment":
                data = obj.get("module_data")
                rows = data.get("data_by_tcin") if isinstance(data, dict) else None
                for row in rows if isinstance(rows, list) else ():
                    if isinstance(row, dict) and str(row.get("tcin")) == sku and isinstance(row.get("three_up_sections"), list):
                        values["fulfillmentSections"].add(len(row["three_up_sections"]))
    return {key: next(iter(found)) if len(found) == 1 else None for key, found in values.items()}


def public_html(url):
    req = Request(url, method="GET", headers={"Accept": "text/html"})
    try:
        with build_opener(NoRedirect).open(req, timeout=20) as response:
            if response.status != 200 or response.headers.get_content_type() != "text/html":
                return response.status, None, "Expected a public HTML listing"
            limit = 5_000_000
            body = response.read(limit + 1)
            if len(body) > limit:
                return response.status, None, "Listing exceeded size limit"
            html = body.decode(response.headers.get_content_charset() or "utf-8", errors="replace")
            return response.status, html, None
    except HTTPError as error:
        error.close()
        return error.code, None, "Listing request declined or redirected"
    except (URLError, OSError) as error:
        return None, None, f"Listing request failed: {error}"


def check(model, zip_code=None, details=False):
    status, html, error = public_html(listing(model))
    result = dict(product=model, tcin=PRODUCTS[model][0], httpStatus=status, shippingEligible=None, shipping="unknown")
    if zip_code is not None:
        result["zip"] = zip_code
    if error:
        return dict(result, reason=error)
    nodes = parse_listing(html)
    result["shipping"], result["reason"] = shipping_from_nodes(nodes, model, zip_code)
    evidence = catalog_from_nodes(nodes, model)
    result["shippingEligible"] = evidence["shipToGuestActive"]
    if details:
        result["catalog"] = evidence
    return result


REPORTS = {
    "pro": "https://www.hotstock.io/us/p/playstation-5-pro-console-2tb",
    "base": "https://www.hotstock.io/us/p/sony-playstation-5-ps5-digital-slim-console",
}


def target_item_link(href, sku):
    # Read the retail destination printed in the report without following the link.
    url = urlsplit(href)
    if url.scheme in {"http", "https"} and url.hostname == "goto.target.com":
        destinations = parse_qs(url.query).get("u", [])
        if len(destinations) != 1:
            return False
        url = urlsplit(destinations[0])
    return (url.scheme == "https" and url.hostname in {"www.target.com", "target.com"}
            and url.path.startswith("/p/") and url.path.rstrip("/").endswith("/A-" + sku))


def published_status(html, sku):
    statuses = set()
    for row in parse_listing(html):
        if row.tag != "tr":
            continue
        cells = [c for c in row.children if isinstance(c, Element) and c.tag == "td"]
        def matches(cell):
            return any(n.tag == "a" and target_item_link(n.attrs.get("href") or "", sku) for n in cell.walk())
        if not any(c.text().startswith("Target (Delivery) ") and matches(c) for c in cells):
            continue
        statuses.update(c.text() for c in cells if matches(c) and c.text() in {"IN STOCK", "OUT OF STOCK"})
    return statuses.pop() if len(statuses) == 1 else "unknown"


def check_report(model):
    url = REPORTS[model]
    status, html, error = public_html(url)
    sku = PRODUCTS[model][0]
    result = dict(product=model, tcin=sku, publisher="HotStock", url=url, httpStatus=status,
                  checkedAt=datetime.now(timezone.utc).isoformat(timespec="seconds"),
                  channel="Target (Delivery)", publisherReportedStock="unknown")
    if error:
        return dict(result, reason=error)
    result["publisherReportedStock"] = published_status(html, sku)
    if result["publisherReportedStock"] == "unknown":
        result["reason"] = "No unambiguous stock report for this exact Target item and channel"
    return result


def main():
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--model", choices=["pro", "base", "both"], default="pro")
    cli.add_argument("--zip", help="Optional: require the listing to show this shipping destination.")
    cli.add_argument("--details", action="store_true", help="Also report the listing's SKU-specific catalog flags and fulfillment section count.")
    cli.add_argument("--report", action="store_true", help="Read HotStock's published Target (Delivery) report instead of Target's listing.")
    args = cli.parse_args()
    if args.zip is not None and not re.fullmatch(r"[0-9]{5}", args.zip):
        cli.error("Expected a five-digit ZIP")
    models = ["base", "pro"] if args.model == "both" else [args.model]
    if args.report and (args.zip or args.details):
        cli.error("The publisher report has no destination or Target catalog fields")
    results = [check_report(model) if args.report else check(model, args.zip, args.details) for model in models]
    for result in results:
        print(json.dumps(result))
    field = "publisherReportedStock" if args.report else "shipping"
    return 2 if any(r[field] == "unknown" for r in results) else 0


if __name__ == "__main__":
    sys.exit(main())
