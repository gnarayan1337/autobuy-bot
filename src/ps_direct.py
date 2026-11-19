"""US PlayStation Direct HTTPS monitor for macOS or Linux.

The Python process reads offers and emits alerts. In optional cart mode it
signals the separate browser helper in ps_cart.mjs for one Add attempt.
"""
import argparse
import fcntl
import gzip
import io
import json
import math
import os
import signal
import subprocess
import sys
import time
from contextlib import contextmanager, ExitStack
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from threading import Event
from urllib.error import HTTPError, URLError
from urllib.request import Request, build_opener

from storefront_html import Element, NoRedirect, parse_listing

STORE = "https://direct.playstation.com/en-us/buy-consoles/"
PRODUCTS = {
    "pro": ("playstation5-pro-console", "1000050805", "PlayStation®5 Pro Console"),
    "base": ("playstation5-console-1-tb", "1000049888", "PlayStation®5 Console - 1 TB"),
}
WORK = Path(__file__).resolve().parents[1] / ".runtime" / "ps-direct"
LIMIT = 3_000_000
AVAILABILITY = {f"{scheme}://schema.org/{name}": name
                for scheme in ("http", "https") for name in ("InStock", "OutOfStock")}


def now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def schema(node, kind):
    return bool(set((node.attrs.get("itemtype") or "").split()) &
                {f"http://schema.org/{kind}", f"https://schema.org/{kind}"})


def descendants(node):
    """Keep the primary product's own nodes; exclude nested recommended products."""
    for child in node.children:
        if isinstance(child, Element) and not schema(child, "Product"):
            yield child
            yield from descendants(child)


def offer(html, model):
    """Resolve a single model's primary structured Offer into (stock, evidence)."""
    slug, sku, title = PRODUCTS[model]
    nodes = parse_listing(html)
    for n in nodes:
        if n.tag in {"h1", "h2", "h3", "p"} and n.text().casefold().rstrip(".") in {
                "you have been temporarily placed in a waiting room", "the line is paused"}:
            return "unknown", "public_waiting_room"
    canonical = {n.attrs.get("href") for n in nodes if n.tag == "link" and n.attrs.get("rel") == "canonical"}
    if canonical != {STORE + slug} or [n.text() for n in nodes if n.tag == "h1"] != [title]:
        return "unknown", "wrong or unrecognized product page"
    values = set()
    for product in (n for n in nodes if schema(n, "Product")):
        parts = list(descendants(product))
        ids = {n.attrs.get("content") for n in parts if n.attrs.get("itemprop") == "sku"}
        if ids != {sku}:
            continue
        for container in (n for n in parts if schema(n, "Offer")):
            for n in descendants(container):
                if n.attrs.get("itemprop") == "availability":
                    values.add(n.attrs.get("href") or n.attrs.get("content") or "")
    states = {AVAILABILITY.get(v, "unrecognized") for v in values}
    if states == {"InStock"}:
        return "available", "InStock"
    if states == {"OutOfStock"}:
        return "unavailable", "OutOfStock"
    return "unknown", "missing, conflicting or unrecognized offer availability"


def retry_after(value):
    if value:
        try:
            return max(0, int(value))
        except ValueError:
            try:
                return max(0, math.ceil(parsedate_to_datetime(value).timestamp() - time.time()))
            except (ValueError, TypeError, OverflowError):
                pass
    return 0


def check(model, cached=None):
    slug, sku, _ = PRODUCTS[model]
    url = STORE + slug
    record = dict(model=model, sku=sku, url=url, checkedAt=now(), stock="unknown")
    headers = {"Accept": "text/html", "Accept-Encoding": "gzip", "Cache-Control": "no-cache"}
    validators = (cached or {}).get("validators", {})
    headers.update(validators)
    try:
        try:
            resp = build_opener(NoRedirect).open(Request(url, headers=headers, method="GET"), timeout=15)
        except HTTPError as err:
            resp = err
        with resp:
            code = resp.status
            record.update(httpStatus=code)
            if code == 304 and validators and cached.get("stock") in ("available", "unavailable"):
                record.update(stock=cached["stock"], evidence=cached["evidence"], validators=validators, observedAt=now())
                return record
            if code != 200:
                record.update(evidence=f"HTTP {code}", retryable=code == 429 or 500 <= code < 600,
                              retryAfter=retry_after(resp.headers.get("Retry-After")))
                return record
            if resp.headers.get_content_type() != "text/html":
                return dict(record, evidence="unexpected content type")
            body = resp.read(LIMIT + 1)
            if len(body) > LIMIT:
                return dict(record, evidence="oversize response")
            encoding = (resp.headers.get("Content-Encoding") or "identity").lower()
            if encoding == "gzip":
                with gzip.GzipFile(fileobj=io.BytesIO(body)) as stream:
                    body = stream.read(LIMIT + 1)
            elif encoding != "identity":
                return dict(record, evidence="unexpected content encoding")
            if len(body) > LIMIT:
                return dict(record, evidence="oversize expanded response")
            stock, evidence = offer(body.decode("utf-8", "replace"), model)
            validators = {req: resp.headers[res] for req, res in
                          (("If-None-Match", "ETag"), ("If-Modified-Since", "Last-Modified")) if resp.headers.get(res)}
            return dict(record, stock=stock, evidence=evidence, validators=validators, observedAt=now())
    except (URLError, OSError, EOFError) as err:
        return dict(record, evidence=f"HTTPS read failed: {type(err).__name__}", retryable=True)


def emit(record):
    print(json.dumps({k: v for k, v in record.items() if k != "validators"}), flush=True)


@contextmanager
def lock():
    WORK.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (WORK / "watch.lock").open("a") as stream:
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            yield False
        else:
            yield True


def save(record):
    temporary = WORK / "state.tmp"
    temporary.write_text(json.dumps({k: v for k, v in record.items() if k != "validators"}))
    temporary.replace(WORK / "state.json")


def log_event(event, at):
    with (WORK / "events.jsonl").open("a", encoding="utf-8") as stream:
        stream.write(json.dumps({"source": "Mac HTTPS", "sku": PRODUCTS["pro"][1], "event": event, "detectedAt": at}) + "\n")
        stream.flush()
        os.fsync(stream.fileno())


def alert(test=False, message=None):
    if test:
        message = "Test alert only. Your PS5 Pro watcher is ready."
    elif message is None:
        message = "Sony lists the PS5 Pro in stock."
    print("\a" + message, flush=True)
    if sys.platform != "darwin":
        return "terminal_only"
    try:
        result = subprocess.run(["/usr/bin/osascript", "-e",
                                 'on run argv\n display notification (item 1 of argv) with title "PlayStation Direct" sound name "Glass"\nend run',
                                 message], timeout=5, capture_output=True)
        return "requested" if result.returncode == 0 else "notification_error"
    except (OSError, subprocess.TimeoutExpired):
        return "notification_error"


def watch(interval, auto_cart=False):
    stop = Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stop.set())
    with lock() as acquired, ExitStack() as cleanup:
        if not acquired:
            print("A PlayStation Direct watch is already running.", file=sys.stderr)
            return 1
        stop_file = WORK / "stop"
        stop_file.unlink(missing_ok=True)
        helper = None
        if auto_cart:
            try:
                helper = subprocess.Popen(["node", str(Path(__file__).with_name("ps_cart.mjs"))],
                                          stdin=subprocess.PIPE, text=True, start_new_session=True)
                cleanup.callback(helper.stdin.close)
            except OSError:
                emit({"cartHelper": "Could not start Chrome helper; stock alerts will continue."})
        previous = None
        errors = 0
        record = {"stock": "unknown"}
        save(dict(record, phase="starting", pid=os.getpid()))
        log_event("watch_started", now())
        while not stop.is_set() and not stop_file.exists():
            started = time.monotonic()
            record = check("pro", previous)
            record.update(intervalSeconds=interval, autoCart=auto_cart)
            stock = record["stock"]
            if stock == "available":
                record["detectedAt"] = record.get("observedAt") or now()
                log_event("in_stock", record["detectedAt"])
                if auto_cart and helper:
                    try:
                        helper.stdin.write("add-one\n")
                        helper.stdin.flush()
                        record["cartHandoff"] = "requested"
                    except (BrokenPipeError, OSError):
                        record["cartHandoff"] = "helper_unavailable"
                record["macNotification"] = alert()
                save(dict(record, phase="alerted"))
                emit(record)
                return 0
            if stock == "unknown" and not record.get("retryable"):
                record["detectedAt"] = record.get("observedAt") or now()
                queue = record.get("evidence") == "public_waiting_room"
                log_event("public_waiting_room" if queue else "stock_check_unavailable", record["detectedAt"])
                record["macNotification"] = alert(message="Sony returned a waiting room to the public check. Check your original Sony tab." if queue else "Stock monitoring needs attention. Check the original Sony tab and watcher status.")
                save(dict(record, phase="needs_attention"))
                emit(record)
                return 2
            errors = errors + 1 if stock == "unknown" else 0
            delay = (max(record.get("retryAfter", 0), min(300, max(15, interval) * 2 ** min(errors - 1, 5)))
                     if errors else max(0, interval - (time.monotonic() - started)))
            save(dict(record, phase="backoff" if errors else "watching", nextCheckInSeconds=round(delay), pid=os.getpid()))
            if not previous or (stock, record["evidence"]) != (previous["stock"], previous["evidence"]):
                emit(record)
            previous = record
            deadline = time.monotonic() + delay
            while not stop.is_set() and not stop_file.exists() and time.monotonic() < deadline:
                stop.wait(max(0, min(1, deadline - time.monotonic())))
        save(dict(record, phase="stopped"))
        return 0


def main():
    cli = argparse.ArgumentParser(description=__doc__)
    commands = cli.add_subparsers(dest="cmd", required=True)
    once = commands.add_parser("check")
    once.add_argument("--model", choices=["pro", "base", "both"], default="pro")
    watcher = commands.add_parser("watch")
    watcher.add_argument("--interval", type=int, default=3, help="Seconds between healthy checks (default 3)")
    watcher.add_argument("--add-to-cart", action="store_true", help="On restock, try the Pro Add button once in dedicated Chrome.")
    commands.add_parser("test-alert")
    commands.add_parser("window", help="Open the official Pro page in the cart helper's Chrome profile on macOS")
    commands.add_parser("status")
    commands.add_parser("stop")
    args = cli.parse_args()
    if args.cmd == "test-alert":
        result = alert(test=True)
        emit({"macNotification": result})
        return int(result == "notification_error")
    if args.cmd == "check":
        models = ["pro", "base"] if args.model == "both" else [args.model]
        records = []
        for model in models:
            result = check(model)
            emit(result)
            records.append(result)
            if result.get("httpStatus") in (401, 403, 429):
                break
        return 2 if any(r["stock"] == "unknown" for r in records) else 0
    if args.cmd == "watch":
        if args.interval < 1:
            cli.error("Use a positive interval.")
        return watch(args.interval, args.add_to_cart)
    with lock() as idle:
        if args.cmd == "window":
            if sys.platform != "darwin" or idle:
                print("Open the cart window while the macOS cart-enabled watch is running.", file=sys.stderr)
                return 1
            state = json.loads((WORK / "state.json").read_text())
            if not state.get("autoCart"):
                print("Cart mode is off.", file=sys.stderr)
                return 1
            binary = Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
            if not binary.exists():
                print("Google Chrome is unavailable.", file=sys.stderr)
                return 1
            profile = WORK / "cart-profile"
            if not (profile / "SingletonLock").is_symlink():
                print("The dedicated Chrome window is closed.", file=sys.stderr)
                return 1
            subprocess.Popen([str(binary), "--user-data-dir=" + str(profile), "--profile-directory=Default",
                              STORE + PRODUCTS["pro"][0]], stdin=subprocess.DEVNULL,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
            print("Requested the Sony Pro page in the dedicated cart profile.")
        elif args.cmd == "stop":
            if not idle:
                (WORK / "stop").touch()
            print("Already stopped." if idle else "Stop requested.")
        else:
            state = WORK / "state.json"
            cart = WORK / "cart-state.json"
            emit({"running": not idle, "last": json.loads(state.read_text()) if state.exists() else None,
                  "cartHelper": json.loads(cart.read_text()) if cart.exists() else None})
    return 0


if __name__ == "__main__":
    sys.exit(main())
