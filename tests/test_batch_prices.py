import copy
import json
import unittest
import urllib.request

from kyara.batch_prices import parse_prices, refresh_prices, ROUTE
from kyara.browser import BrowserOpener
from kyara.collector import DataError
from kyara.metadata import collect_metadata, collect_odds_samples


class BatchPriceTests(unittest.TestCase):
    def test_explicit_medians_and_missing_windows_are_distinct(self):
        rows = parse_prices([{"id": 1, "median7d": None, "median30d": 20, "sales30d": 3}], {"1", "2"})
        self.assertIsNone(rows["1"]["median7d"])
        self.assertNotIn("2", rows)
        self.assertEqual(parse_prices({"1": {"median7d": 10, "median30d": 20}}, {"1"})["1"]["median7d"], 10)

    def test_fair_prices_and_malformed_values_never_become_medians(self):
        invalid = [{"1": 10}, [{"id": 1, "median7d": 10}],
                   [{"id": 1, "median7d": -1, "median30d": 0}],
                   [{"id": 2, "median7d": 1, "median30d": 2}],
                   [{"id": 1, "median7d": 1, "median30d": 2}] * 2]
        for body in invalid:
            with self.subTest(body=body), self.assertRaises(DataError):
                parse_prices(body, {"1"})

    def test_refresh_uses_batches_and_does_not_relabel_old_prices(self):
        old = {"catalog": [{"id": i} for i in range(1, 402)],
               "prices": {"401": {"median7d": 999}}, "characters": {"1": {"dropChance": {}}},
               "fetched_at": {"/market/prices/401": "2026-01-01T00:00:00Z"}}
        saved = copy.deepcopy(old)
        class Client:
            def __init__(self): self.paths, self.fetched_at = [], {}
            def get(self, path, ttl):
                self.paths.append(path)
                self.fetched_at[path] = "2026-11-05T12:00:00Z"
                ids = path.split("ids=")[1].split(",")
                return [{"id": i, "median7d": 10, "median30d": 11} for i in ids if i != "401"]
        client = Client()
        result = refresh_prices(client, old)
        self.assertEqual(len(client.paths), 3)
        self.assertTrue(all(path.startswith(ROUTE) for path in client.paths))
        self.assertEqual(result["price_refresh"]["missing_card_ids"], ["401"])
        self.assertFalse(result["price_refresh"]["complete_response_coverage"])
        self.assertNotIn("401", result["prices"])
        self.assertNotIn("/market/prices/401", result["fetched_at"])
        self.assertEqual(result["price_sources"]["1"], ROUTE)
        self.assertEqual(old, saved)

    def test_browser_bridge_gets_only_allowed_batches_without_exporting_auth(self):
        scripts, waits = [], []
        replies = iter(["started", '{"done":false}', '{"done":true,"status":200,"body":[{"id":1,"median7d":10,"median30d":12}]}'])
        def run(script, app):
            scripts.append(script)
            return next(replies)
        opener = BrowserOpener(runner=run, sleep=waits.append)
        request = urllib.request.Request("https://kyara.games/api/me/collection/prices?ids=1", headers={"Authorization": "SECRET"})
        with opener(request) as response:
            self.assertEqual(json.load(response)[0]["median7d"], 10)
        self.assertEqual(waits, [.2])
        self.assertNotIn("SECRET", "".join(scripts))
        self.assertIn("redirect:'error'", scripts[0])
        self.assertIn("location.origin", scripts[0])

    def test_browser_bridge_rejects_other_origins_methods_and_account_routes(self):
        opener = BrowserOpener(runner=lambda *_: self.fail("Should not execute JavaScript"))
        for request in [urllib.request.Request("https://other.example/api/me/collection/prices?ids=1"),
                        urllib.request.Request("https://kyara.games/api/me"),
                        urllib.request.Request("https://kyara.games/api/me/collection/prices?ids=1", method="POST")]:
            with self.assertRaises(DataError): opener(request)

    def test_metadata_collection_checks_pools_and_samples_each_rarity_once(self):
        responses = {"/characters": [{"id": 1, "rarity": "C"}, {"id": 2, "rarity": "R"}, {"id": 3, "rarity": "C"}],
                     "/packs": [{"id": "a", "rates": {"poolSize": 3}}], "/rates": [],
                     "/config": {"dropWeights": {"C": 3, "R": 1}, "unrelated": "omit"},
                     "/packs/a/characters": [1, 2, 3], "/characters/1": {"id": 1}, "/characters/2": {"id": 2}}
        class Client:
            def __init__(self): self.paths, self.fetched_at = [], {}
            def get(self, path, ttl):
                self.paths.append(path)
                self.fetched_at[path] = "2026-11-06T00:00:00Z"
                return copy.deepcopy(responses[path])
        client = Client()
        raw = collect_odds_samples(client, collect_metadata(client))
        self.assertEqual(set(raw["characters"]), {"1", "2"})
        self.assertNotIn("unrelated", raw["rules"]["config"])
        self.assertEqual(raw["odds_sample_collection"]["cards"], 2)
        responses["/packs/a/characters"] = [1, 1, 2]
        with self.assertRaises(DataError): collect_metadata(Client())

    def test_browser_bridge_allows_catalogue_reads_without_private_api_access(self):
        replies = iter(["started", '{"done":true,"status":200,"body":[]}'])
        opener = BrowserOpener(runner=lambda *_: next(replies))
        with opener(urllib.request.Request("https://kyara.games/api/characters")) as response:
            self.assertEqual(json.load(response), [])


if __name__ == "__main__":
    unittest.main()
