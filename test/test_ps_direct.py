import gzip
import io
import sys
import unittest
from email.message import Message
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
import ps_direct as ps


def page(model="pro", state="https://schema.org/OutOfStock", extra=""):
    slug, sku, name = ps.PRODUCTS[model]
    return f"""<link rel="canonical" href="{ps.STORE}{slug}"><h1>{name}</h1>
      <div itemscope itemtype="https://schema.org/Product"><meta itemprop="sku" content="{sku}">
      <div itemscope itemtype="http://schema.org/Offer"><link itemprop="availability" href="{state}"></div>{extra}
      <button class="hide">Add</button><p hidden>Currently Unavailable</p></div>"""


class Response(io.BytesIO):
    def __init__(self, status=200, body=b"", **headers):
        super().__init__(body)
        self.status = status
        self.headers = Message()
        self.headers["Content-Type"] = "text/html"
        for k, v in headers.items():
            self.headers[k] = v


class SonyDirect(unittest.TestCase):
    def test_both_observed_states_even_with_hidden_templates(self):
        self.assertEqual(ps.offer(page(), "pro")[0], "unavailable")
        self.assertEqual(ps.offer(page("base", "http://schema.org/InStock"), "base")[0], "available")
        self.assertEqual(ps.offer(page(state="http://schema.org/InStock"), "pro")[0], "available")

    def test_no_offer_wrong_page_or_unfamiliar_offer(self):
        for html in (page("base", "http://schema.org/InStock"), "<h1>Add to cart</h1>",
                     page().replace('itemprop="availability"', ''), page().replace('1000050805', 'other'),
                     page(state="https://schema.org/PreOrder")):
            with self.subTest(): self.assertEqual(ps.offer(html, "pro")[0], "unknown")

    def test_public_waiting_room_is_distinct_from_unknown_or_stock(self):
        self.assertEqual(ps.offer('<h2>The line is paused.</h2>', 'pro'), ('unknown', 'public_waiting_room'))
        self.assertEqual(ps.offer('<h1>Your basket</h1>', 'pro')[0], 'unknown')
        self.assertRegex(ps.now(), r'\.\d{3}\+00:00$')

    def test_nested_accessory_and_contradictory_offers(self):
        other = '<div itemtype="https://schema.org/Offer"><link itemprop="availability" href="http://schema.org/InStock"></div>'
        self.assertEqual(ps.offer(page(extra=other), "pro")[0], "unknown")
        self.assertEqual(ps.offer(page(extra=f'<div itemtype="https://schema.org/Product">{other}</div>'), "pro")[0], "unavailable")

    @patch("ps_direct.build_opener")
    def test_gzip_and_conditional_get(self, opener):
        opener.return_value.open.side_effect = [
            Response(200, gzip.compress(page().encode()), **{"Content-Encoding": "gzip", "ETag": '"v1"'}),
            Response(304), Response(304)]
        first = ps.check("pro")
        second = ps.check("pro", first)
        self.assertEqual(second["stock"], "unavailable")
        req = opener.return_value.open.call_args.args[0]
        self.assertEqual(req.get_method(), "GET")
        self.assertIn(("If-none-match", '"v1"'), req.header_items())
        self.assertEqual(ps.check("pro")["stock"], "unknown")

    @patch("ps_direct.build_opener")
    def test_throttling_and_denial_do_not_signal_availability(self, opener):
        opener.return_value.open.side_effect = [Response(429, **{"Retry-After": "120"}), Response(403), Response(302)]
        limited = ps.check("pro")
        self.assertEqual((limited["stock"], limited["retryable"], limited["retryAfter"]), ("unknown", True, 120))
        self.assertFalse(ps.check("pro")["retryable"])
        self.assertFalse(ps.check("pro")["retryable"])

    def test_watch_waits_through_unavailability_then_alerts_and_stops(self):
        with TemporaryDirectory() as tmp, patch.object(ps, "WORK", Path(tmp)), \
             patch.object(ps.signal, "signal"), patch.object(ps, "emit"), \
             patch.object(ps, "alert", return_value="requested") as notify, patch.object(ps, "check") as check:
            unavailable = {"stock": "unavailable", "evidence": "OutOfStock"}
            available = {"stock": "available", "evidence": "InStock"}
            check.side_effect = [unavailable, unavailable, available]
            self.assertEqual(ps.watch(0), 0)
            self.assertEqual(check.call_count, 3)
            self.assertTrue(all(call.args[0] == "pro" for call in check.call_args_list))
            notify.assert_called_once()
            events = [ps.json.loads(row) for row in (Path(tmp) / 'events.jsonl').read_text().splitlines()]
            self.assertEqual([e['event'] for e in events], ['watch_started', 'in_stock'])
            self.assertEqual(events[-1]['detectedAt'], ps.json.loads((Path(tmp) / 'state.json').read_text())['detectedAt'])
            self.assertIn('"phase": "alerted"', (Path(tmp) / "state.json").read_text())
            with ps.lock() as free:
                self.assertTrue(free)


if __name__ == "__main__":
    unittest.main()
