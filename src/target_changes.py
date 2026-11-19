"""Compare independent public Target HTTPS responses. Never changes a browser or cart."""
import argparse
import gzip
import hashlib
import io
import json
import math
import os
import time
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, build_opener

from shipping_http import PRODUCTS, listing, parse_listing, shipping_controls, shipping_from_nodes, catalog_from_nodes
from storefront_html import NoRedirect

LIMIT = 5_000_000
DEFAULT_LOG = Path(__file__).resolve().parents[1] / ".runtime" / "target-public-changes.jsonl"
STATUS_KEYS = {"IN_STOCK": "available", "OUT_OF_STOCK": "unavailable", "UNAVAILABLE": "unavailable",
               "NOT_SOLD_ONLINE": "unavailable"}


def now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def published_shipping_options(nodes, sku):
    """Only look at shipping_options on a product explicitly identified by this TCIN."""
    statuses = set()
    option_hashes = set()
    for n in nodes:
        if n.tag != "script" or n.attrs.get("type") != "application/json":
            continue
        try:
            stack = [json.loads("".join(n.children))]
        except (TypeError, ValueError, RecursionError):
            continue
        while stack:
            item = stack.pop()
            if isinstance(item, list):
                stack.extend(item)
            elif isinstance(item, dict):
                stack.extend(item.values())
                if str(item.get("tcin")) != sku:
                    continue
                f = item.get("fulfillment")
                opts = f.get("shipping_options") if isinstance(f, dict) else None
                if not isinstance(opts, (dict, list)):
                    continue
                # Preserve a change in an unfamiliar shipping field without writing its contents to disk.
                encoded = json.dumps(opts, sort_keys=True, separators=(",", ":")).encode()
                option_hashes.add(hashlib.sha256(encoded).hexdigest())
                status = opts.get("availability_status") if isinstance(opts, dict) else None
                if isinstance(status, str) and 0 < len(status) < 64 and status.replace("_", "").isalpha():
                    statuses.add(status.upper())
    return sorted(statuses), sorted(option_hashes)


def snapshot(body, model):
    """Validate the item and extract comparable shipping, catalog and body fields."""
    nodes = parse_listing(body.decode("utf-8", "replace"))
    # Identity check also prevents challenges, login pages and redirects from becoming change alerts.
    canon = {n.attrs.get("href") for n in nodes if n.tag == "link" and n.attrs.get("rel") == "canonical"}
    if canon != {listing(model)} or [n.text() for n in nodes if n.tag == "h1"] != [PRODUCTS[model][2]]:
        raise ValueError("Product identity unverified; stopping")
    page_text = nodes[0].text().casefold()
    if any(word in page_text for word in ("verify you are human", "verify that you are human", "access denied", "too many requests", "press and hold to verify")):
        raise ValueError("Storefront requested attention; stopping")
    _, tile = shipping_controls(nodes)
    tile_state, _ = shipping_from_nodes(nodes, model, None)
    statuses, option_hashes = published_shipping_options(nodes, PRODUCTS[model][0])
    json_state = STATUS_KEYS.get(statuses[0], "unknown") if len(statuses) == 1 else "unknown"
    decisive = {x for x in (json_state, tile_state) if x != "unknown"}
    # If either source contradicts itself or the other source, avoid a restock claim.
    resolved = decisive.pop() if len(decisive) == 1 and len(statuses) <= 1 else "unknown"
    shipping = {
        "availability": resolved, "tileState": tile_state, "embeddedShippingStatuses": statuses,
        "shippingOptionHashes": option_hashes,
        "shippingButton": None if not tile else {
            "text": tile.text()[:180], "label": (tile.attrs.get("aria-label") or "")[:180],
            "disabled": "disabled" in tile.attrs or tile.attrs.get("aria-disabled") == "true",
            "availabilityClasses": sorted({c.split("__", 1)[0] for c in (tile.attrs.get("class") or "").split()
                                          if "FulfillmentCell__" in c}),
        },
    }
    catalog = catalog_from_nodes(nodes, model)
    return {"bodySHA256": hashlib.sha256(body).hexdigest(), "shipping": shipping, "catalog": catalog}


def compare(old, new):
    """Classify a same-item transition and return the changed semantic fields.

    Callers keep a separate baseline per model. A document hash can change
    even when the retailer supplies identical shipping evidence.
    """
    if old is None:
        return "baseline", []
    changed = [f"{group}.{key}" for group in ("shipping", "catalog")
               for key in new[group] if new[group][key] != old[group][key]]
    if any(k.startswith("shipping.") for k in changed):
        return "shipping_data_changed", changed
    if changed:
        return "catalog_changed", changed
    return ("other_page_bytes_changed" if new["bodySHA256"] != old["bodySHA256"] else "unchanged"), []


def fetch(model, etag=None, modified=None):
    headers = {"Accept": "text/html", "Accept-Encoding": "gzip", "Cache-Control": "no-cache"}
    if etag:
        headers["If-None-Match"] = etag
    if modified:
        headers["If-Modified-Since"] = modified
    try:
        response = build_opener(NoRedirect).open(Request(listing(model), headers=headers), timeout=15)
    except HTTPError as err:
        response = err
    with response:
        code = response.status
        meta = {k: response.headers[k] for k in ("ETag", "Last-Modified", "Retry-After", "Date", "Age") if k in response.headers}
        if code != 200:
            return code, meta, None
        if response.headers.get_content_type() != "text/html":
            raise ValueError("Unexpected media type; stopping")
        body = response.read(LIMIT + 1)
        if len(body) > LIMIT:
            raise ValueError("Oversize response")
        if response.headers.get("Content-Encoding", "").lower() == "gzip":
            with gzip.GzipFile(fileobj=io.BytesIO(body)) as gz:
                body = gz.read(LIMIT + 1)
        if len(body) > LIMIT:
            raise ValueError("Oversize expanded response")
        return code, meta, body


def retry_seconds(value):
    if not value:
        return 0
    try:
        return max(0, int(value))
    except ValueError:
        try:
            return max(0, math.ceil(parsedate_to_datetime(value).timestamp() - time.time()))
        except (TypeError, ValueError, OverflowError):
            return 0


def poll(models, interval, rounds, output):
    """Emit one JSON-ready observation per attempted read to the output callback.

    Validators and snapshots belong to this process. A completed finite run
    may return success with unknown stock. The event describes the read and
    shipping.availability describes the offer.
    """
    latest, validators = {}, {}
    turn = failures = 0
    incomplete = False
    while not rounds or turn < rounds:
        turn += 1
        incomplete = False
        for model in models:
            row = {"round": turn, "product": model, "tcin": PRODUCTS[model][0], "requestedAt": now()}
            try:
                tag, mod = validators.get(model, (None, None))
                code, headers, body = fetch(model, tag, mod)
                row.update(httpStatus=code, sampledAt=now())
                if code == 304 and model in latest and (tag or mod):
                    row.update(event="not_modified", **latest[model])
                elif code == 200:
                    current = snapshot(body, model)
                    event, changes = compare(latest.get(model), current)
                    row.update(event=event, changedFields=changes, **current)
                    validators[model] = (headers.get("ETag"), headers.get("Last-Modified"))
                    latest[model] = current
                elif code == 429 or code >= 500:
                    row.update(event="backoff", retryAfter=retry_seconds(headers.get("Retry-After")))
                else:
                    row.update(event="stopped", reason=f"HTTP {code}; no alternate routes or redirects followed")
            except (URLError, OSError, EOFError) as error:
                row.update(event="backoff", reason=type(error).__name__)
            except ValueError as error:
                row.update(event="stopped", reason=str(error))
            row["observedAt"] = now()
            output(row)
            if row["event"] == "stopped":
                return 2
            if row["event"] == "backoff":
                failures += 1
                incomplete = True
                if not rounds or turn < rounds:
                    time.sleep(max(interval, row.get("retryAfter", 0), min(900, 30 * 2 ** min(failures, 5))))
                break
        else:
            failures = 0
            if not rounds or turn < rounds:
                time.sleep(interval)
    return 2 if incomplete or len(latest) != len(models) else 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", choices=["pro", "base", "both"], default="pro")
    parser.add_argument("--interval", type=int, default=30, help="Seconds between completed rounds (default 30)")
    parser.add_argument("--rounds", type=int, default=0, help="0 continues until interrupted")
    parser.add_argument("--log", type=Path, default=DEFAULT_LOG)
    args = parser.parse_args()
    if args.interval < 1 or args.rounds < 0:
        parser.error("Use a positive interval and nonnegative round count")
    args.log.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    models = ["base", "pro"] if args.model == "both" else [args.model]
    def output(row):
        line = json.dumps(row, ensure_ascii=False)
        with os.fdopen(os.open(args.log, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600), "a") as stream:
            stream.write(line + "\n")
        print(line, flush=True)
    try:
        return poll(models, args.interval, args.rounds, output)
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
