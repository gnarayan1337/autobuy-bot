import sys
import unittest
import json
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from shipping_http import PRODUCTS, catalog_evidence, listing, shipping_from_html, main, published_status


def page(model="base", shipping="Arrives by Fri, Nov 20", destination="Ship to 75013", pickup="Only 1 left", attrs=""):
    return f"""<link rel="canonical" href="{listing(model)}">
    <h1>{PRODUCTS[model][2]}</h1><section aria-label="Fulfillment">
    <button>Pickup {pickup}</button><button>Delivery as soon as 8pm</button>
    <button id="SHIPPING" {attrs}>Shipping {shipping}</button><div>{destination}</div>
    </section><aside>In stock. Ship to 75013. Arrives tomorrow</aside>"""


class TestPublicListing(unittest.TestCase):
    def test_published_stock_is_scoped_to_retailer_channel_and_item(self):
        def row(dest, label, stock):
            return f'<tr><td><a href="{dest}">{label} Console</a></td><td><a href="{dest}">{stock}</a></td></tr>'
        pro = listing("pro")
        valid = row("http://goto.target.com/example?u=" + pro, "Target (Delivery)", "OUT OF STOCK")
        distractors = (row(pro, "Target (Pickup)", "IN STOCK") +
                       row(listing("base"), "Target (Delivery)", "IN STOCK") +
                       row(pro.replace("www.target.com", "www.target.com.invalid"), "Target (Delivery)", "IN STOCK"))
        self.assertEqual(published_status(distractors, "93620188"), "unknown")
        self.assertEqual(published_status(valid + distractors, "93620188"), "OUT OF STOCK")
        self.assertEqual(published_status(valid + row(pro, "Target (Delivery)", "IN STOCK"), "93620188"), "unknown")
        self.assertEqual(published_status(valid, "94961316"), "unknown")

    def test_shipping_read_without_a_zip(self):
        for model in PRODUCTS:
            for tile, expected in [("Arrives tomorrow", "available"), ("Not available", "unavailable"),
                                   ("loading...", "unknown"), ("", "unknown")]:
                with self.subTest(model=model, tile=tile):
                    self.assertEqual(shipping_from_html(page(model, shipping=tile, destination=""), model)[0], expected)
        self.assertEqual(shipping_from_html(page(destination="Ship to 10001"), "base")[0], "available")
        self.assertEqual(shipping_from_html(page(destination="Ship to 10001"), "base", "75013")[0], "unknown")

    def test_rendered_class_is_independent_of_selection_and_wording(self):
        for css, text, expected in [
            ("styles_notActiveAndAvailableFulfillmentCell__wylMF", "Standard parcel", "available"),
            ("styles_activeAndUnavailableFulfillmentCell__XjAi0", "Standard parcel", "unavailable"),
            ("styles_notActiveAndAvailableFulfillmentCell__newhash", "loading...", "unknown"),
            ("styles_activeAndAvailableFulfillmentCell__test", "Not available", "unavailable"),
        ]:
            with self.subTest(css=css, text=text):
                html = page(shipping=text, destination="", attrs=f'class="{css}"')
                self.assertEqual(shipping_from_html(html, "base")[0], expected)

    def test_cli_default_does_not_filter_by_zip(self):
        with patch("sys.argv", ["checker"]), patch("shipping_http.check", return_value={"shipping": "unknown"}) as checked, patch("builtins.print"):
            self.assertEqual(main(), 2)
        checked.assert_called_once_with("pro", None, False)

    def test_active_shipping_rule_and_fast_selling_do_not_signal_stock(self):
        def product(sku, active):
            return {"tcin": sku, "item": {"eligibility_rules": {"ship_to_guest": {"is_active": active}}},
                    "fast_selling": {"fast_selling": active}}
        data = [product("94961316", False), product("93620188", True),
                {"module_type": "ProductDetailFulfillment", "module_data": {"data_by_tcin": [
                    {"tcin": "94961316", "three_up_sections": [{}]},
                    {"tcin": "93620188", "three_up_sections": []}]}}]
        html = page("pro", shipping="loading...", destination="") + '<script type="application/json">' + json.dumps(data) + '</script>'
        self.assertEqual(catalog_evidence(html, "pro"), {"shipToGuestActive": True, "fastSelling": True, "fulfillmentSections": 0})
        self.assertEqual(shipping_from_html(html, "pro", "75013")[0], "unknown")

    def test_zip_echo_in_script_is_not_shipping_destination(self):
        html = page(destination="") + '<script type="application/json">{"query":{"zip":"75013"}}</script>'
        self.assertEqual(shipping_from_html(html, "base", "75013")[0], "unknown")
        self.assertIsNone(catalog_evidence(html, "base")["fulfillmentSections"])

    def test_shipping_offer_for_either_model(self):
        for model in PRODUCTS:
            with self.subTest(model=model):
                self.assertEqual(shipping_from_html(page(model=model), model, "75013")[0], "available")

    def test_model_and_zip_must_match(self):
        for model, zip_code in [("pro", "75013"), ("base", "10001")]:
            self.assertEqual(shipping_from_html(page(), model, zip_code)[0], "unknown")

    def test_loading_is_unknown_even_if_other_fulfillment_is_in_stock(self):
        result, reason = shipping_from_html(page(shipping="", attrs='aria-label="shipping - loading..." disabled'), "base", "75013")
        self.assertEqual(result, "unknown")
        self.assertIn("loading placeholder", reason)

    def test_pickup_and_generic_offers_do_not_establish_shipping(self):
        self.assertEqual(shipping_from_html(page(shipping=""), "base", "75013")[0], "unknown")

    def test_explicit_shipping_unavailable(self):
        self.assertEqual(shipping_from_html(page(shipping="Not available"), "base", "75013")[0], "unavailable")

    def test_destination_omitted_or_conflicting(self):
        for text in ["", "Ship to 10001 / Ship to 75013"]:
            self.assertEqual(shipping_from_html(page(destination=text), "base", "75013")[0], "unknown")

    def test_absent_offer_and_challenge_do_not_count(self):
        self.assertEqual(shipping_from_html("<h1>Verify you are human</h1>", "base", "75013")[0], "unknown")

    def test_main_exit_code_preserves_unknown(self):
        with patch("sys.argv", ["checker", "--model", "both"]), patch("shipping_http.check", side_effect=[
            {"shipping": "available"}, {"shipping": "unknown"}]), patch("builtins.print"):
            self.assertEqual(main(), 2)


if __name__ == "__main__":
    unittest.main()
