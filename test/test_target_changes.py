import copy
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/"src"))
import target_changes as changes
from shipping_http import listing


def page(tile="loading...", scripts=(), pickup="ready in two hours", noise="unchanged"):
    data = "".join('<script type="application/json">'+json.dumps(obj)+'</script>' for obj in scripts)
    return (f'<link rel="canonical" href="{listing("pro")}"><h1>PlayStation 5 Pro Console</h1>'
            f'<section aria-label="Fulfillment"><button>Pickup {pickup}</button><button>Delivery today</button>'
            f'<button id="SHIPPING" aria-label="Shipping {tile}">Shipping {tile}</button></section>{data}<!--{noise}-->').encode()


def offer(sku, status):
    return {"data":{"product":{"tcin":sku,"fulfillment":{"shipping_options":{"availability_status":status}}}}}


class PublicChanges(unittest.TestCase):
    def test_page_churn_and_pickup_do_not_become_shipping_events(self):
        a=changes.snapshot(page(),"pro")
        b=changes.snapshot(page(pickup="unavailable",noise="different"),"pro")
        self.assertEqual(changes.compare(a,b),("other_page_bytes_changed",[]))
        self.assertEqual(b["shipping"]["availability"],"unknown")

    def test_unfamiliar_tile_change_is_logged_without_claiming_stock(self):
        a=changes.snapshot(page(),"pro")
        b=changes.snapshot(page(tile="Check your address"),"pro")
        self.assertEqual(changes.compare(a,b)[0],"shipping_data_changed")
        self.assertEqual(b["shipping"]["availability"],"unknown")

    def test_scoped_json_and_conflicts(self):
        baseline=changes.snapshot(page(),"pro")
        good=changes.snapshot(page(scripts=[offer("93620188","IN_STOCK")]),"pro")
        self.assertEqual(good["shipping"]["availability"],"available")
        self.assertIn("shipping.embeddedShippingStatuses",changes.compare(baseline,good)[1])
        wrong=changes.snapshot(page(scripts=[offer("94961316","IN_STOCK")]),"pro")
        self.assertEqual(wrong["shipping"]["availability"],"unknown")
        conflict=changes.snapshot(page(tile="Not available",scripts=[offer("93620188","IN_STOCK")]),"pro")
        self.assertEqual(conflict["shipping"]["availability"],"unknown")

    def test_positive_tile_transition_and_catalog_only(self):
        a=changes.snapshot(page(tile="Not available"),"pro")
        b=changes.snapshot(page(tile="Arrives by Friday"),"pro")
        self.assertEqual(b["shipping"]["availability"],"available")
        self.assertEqual(changes.compare(a,b)[0],"shipping_data_changed")
        c=copy.deepcopy(a); c["catalog"]["fastSelling"]=True
        self.assertEqual(changes.compare(a,c),("catalog_changed",["catalog.fastSelling"]))

    def test_unfamiliar_shipping_option_changes_without_an_inventory_claim(self):
        def sample(promise):
            data = {"tcin": "93620188", "fulfillment": {"shipping_options": {"promise": promise}}}
            return changes.snapshot(page(scripts=[data]), "pro")

        earlier = sample("Friday")
        later = sample("Saturday")
        self.assertEqual(changes.compare(earlier, later), ("shipping_data_changed", ["shipping.shippingOptionHashes"]))
        self.assertEqual(later["shipping"]["availability"], "unknown")

    def test_conditional_get_and_denial_stop(self):
        rows=[]
        with patch.object(changes,"fetch",side_effect=[(200,{"ETag":'"v"'},page()),(304,{},None),(403,{},None)]) as fetch:
            self.assertEqual(changes.poll(["pro"],0,10,rows.append),2)
            self.assertEqual(fetch.call_args_list[1].args,("pro",'"v"',None))
            self.assertEqual([r["event"] for r in rows],["baseline","not_modified","stopped"])
            self.assertEqual(rows[1]["shipping"],rows[0]["shipping"])

    def test_invalid_response_doesnt_turn_into_a_change(self):
        with self.assertRaises(ValueError):
            changes.snapshot(b'<h1>Verification required</h1>',"pro")
        rows=[]
        with patch.object(changes,"fetch", return_value=(429,{"Retry-After":"180"},None)):
            self.assertEqual(changes.poll(["pro","base"],0,1,rows.append),2)
        self.assertEqual((len(rows),rows[0]["retryAfter"]),(1,180))


if __name__=="__main__":
    unittest.main()
