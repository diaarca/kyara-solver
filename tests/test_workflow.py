import copy
import io
import json
import math
import os
from pathlib import Path
import random
import sqlite3
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

from kyara.collector import (
    Client, DataError, database, digest, import_har, main, mechanics_digest,
    moments, normalize, save,
)
from kyara.baseline import verify_baseline

FIXTURES = Path(__file__).parent / "fixtures"


def fixture():
    return (json.loads((FIXTURES / "raw.json").read_text()),
            json.loads((FIXTURES / "verification.json").read_text()))


class CollectorTests(unittest.TestCase):
    def baseline_fixture(self):
        # Two cards, two slots: C-or-R (75/25), then guaranteed R.
        zeros = {r: 0 for r in ("C", "U", "R", "E", "L", "M")}
        raw = {"collected_at": "2026-11-05T12:00:00Z", "catalog": [
            {"id": 1, "name": "Common", "series": "Fixture", "rarity": "C"},
            {"id": 2, "name": "Rare", "series": "Fixture", "rarity": "R"}],
            "pack_pools": {"base": [1, 2]}, "rules": {"config": {"dropWeights": {**zeros, "C": 3, "R": 1}}},
            "characters": {"1": {"id": 1, "rarity": "C", "dropChance": {"base": .75}},
                           "2": {"id": 2, "rarity": "R", "dropChance": {"base": 1}}},
            "prices": {"1": {"median7d": 4, "median30d": 4}, "2": {"median7d": 8, "median30d": 8}}}
        raw["packs"] = [{"id": "base", "name": "Baseline", "chakraPrice": 10, "slots": ["C", "R"],
            "rates": {"poolSize": 2, "cardsByRarity": {**zeros, "C": 1, "R": 1},
                "slots": [{"min": "C", "pct": {**zeros, "C": 75, "R": 25}}, {"min": "R", "pct": {**zeros, "R": 100}}],
                "perBooster": {r: {"expected": .75 if r == "C" else 1.25 if r == "R" else 0,
                                   "atLeastOnePct": 75 if r == "C" else 100 if r == "R" else 0} for r in zeros}}}]
        return raw

    def test_verified_baseline_matches_complete_published_evidence(self):
        raw = self.baseline_fixture()
        verification = verify_baseline(raw, "base")
        self.assertEqual(verification["validation"]["checked_cards"], 2)
        data = normalize(raw, {"boosters": {"base": verification}})
        self.assertEqual(data["boosters"][0]["issues"], [])
        self.assertEqual(data["boosters"][0]["outcomes"][1]["expected_copies"], 1.25)
        self.assertEqual(verification["opening_context"]["type"], "normal_baseline")

    def test_baseline_requires_every_card_probability_and_complete_pool(self):
        for change in ("missing_detail", "wrong_probability", "wrong_pool"):
            raw = self.baseline_fixture()
            if change == "missing_detail":
                del raw["characters"]["2"]
            elif change == "wrong_probability":
                raw["characters"]["1"]["dropChance"]["base"] = .74
            else:
                raw["pack_pools"]["base"] = [1]
            with self.subTest(change=change), self.assertRaises(DataError):
                verify_baseline(raw, "base")

    def test_baseline_rejects_boosted_or_inconsistent_slot_rates(self):
        raw = self.baseline_fixture()
        raw["packs"][0]["rateUp"] = {"M": 2}
        with self.assertRaises(DataError):
            verify_baseline(raw, "base")
        raw = self.baseline_fixture()
        raw["packs"][0]["rates"]["slots"][0]["pct"]["C"] = 74
        with self.assertRaises(DataError):
            verify_baseline(raw, "base")

    def test_published_baseline_checks_samples_and_per_card_rates(self):
        raw = self.baseline_fixture()
        raw["catalog"].append({"id": 3, "name": "Common 2", "series": "Fixture", "rarity": "C"})
        raw["pack_pools"]["base"].append(3)
        rates = raw["packs"][0]["rates"]
        rates["poolSize"] = 3
        rates["cardsByRarity"]["C"] = 2
        for r, values in rates["perBooster"].items():
            values["perCardPct"] = 37.5 if r == "C" else 100 if r == "R" else 0
        raw["characters"]["1"]["dropChance"]["base"] = .375
        result = verify_baseline(raw, "base", published=True)
        self.assertEqual(result["validation"]["checked_cards"], 2)
        self.assertEqual(result["validation"]["pool_cards"], 3)
        self.assertEqual(result["validation"]["level"], "published_rates_with_rarity_samples")
        raw["characters"].pop("2")
        with self.assertRaises(DataError):
            verify_baseline(raw, "base", published=True)

    def test_published_baseline_supports_boosted_published_slot_rates(self):
        raw = self.baseline_fixture()
        rates = raw["packs"][0]["rates"]
        rates["slots"][0]["pct"].update(C=60, R=40)
        rates["perBooster"]["C"].update(expected=.6, atLeastOnePct=60)
        rates["perBooster"]["R"].update(expected=1.4)
        for r, values in rates["perBooster"].items():
            values["perCardPct"] = 60 if r == "C" else 100 if r == "R" else 0
        raw["characters"]["1"]["dropChance"]["base"] = .6
        result = verify_baseline(raw, "base", published=True)
        self.assertEqual(result["validation"]["probability_precision"], "rounded_published_slot_rates")
        rates["perBooster"]["C"]["perCardPct"] = 59
        with self.assertRaises(DataError):
            verify_baseline(raw, "base", published=True)

    def test_failed_published_baseline_is_preserved_as_an_exclusion(self):
        raw = self.baseline_fixture()
        raw["characters"]["1"]["dropChance"]["base"] = .5
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "raw.json").write_text(json.dumps(raw))
            status = main(["--import-raw", str(root / "raw.json"), "--verify-published-baselines",
                           "--database", str(root / "db"), "--output", str(root / "out.json")])
            self.assertEqual(status, 0)
            saved = json.loads((root / "out.json").read_text())
            self.assertIn("baseline validation:", saved["boosters"][0]["issues"][0])

    def test_published_pool_can_include_cards_below_every_slot_minimum(self):
        raw = self.baseline_fixture()
        raw["packs"][0]["slots"] = ["R"]
        rates = raw["packs"][0]["rates"]
        rates["slots"] = [rates["slots"][1]]
        for r, values in rates["perBooster"].items():
            values.update(expected=1 if r == "R" else 0, atLeastOnePct=100 if r == "R" else 0,
                          perCardPct=100 if r == "R" else 0)
        result = verify_baseline(raw, "base", published=True)
        self.assertEqual(result["validation"]["pool_cards"], 2)
        self.assertEqual(result["validation"]["checked_cards"], 1)

    def test_reference_moments_and_profit(self):
        raw, verification = fixture()
        data = normalize(raw, verification)
        pack = data["boosters"][0]
        self.assertEqual(pack["issues"], [])
        self.assertEqual(pack["outcomes"][0]["expected_copies"], 1)
        self.assertEqual(pack["outcomes"][0]["occurrence_probability"], .75)
        price = {c["id"]: c["median7d"] for c in data["cards"]}
        profit = sum(o["expected_copies"] * price[o["card_id"]] for o in pack["outcomes"]) - pack["cost"]
        self.assertEqual(profit, 90)

    def test_guaranteed_slots_and_distinct_cards(self):
        cards = {"1": {}, "2": {}}
        model = {"type": "independent_slots", "slots": [
            {"draws": 2, "probabilities": {"1": .5, "2": .5}},
            {"draws": 1, "probabilities": {"1": 1}},
        ]}
        result = moments(model, cards)
        self.assertEqual(result[0]["expected_copies"], 2)
        self.assertEqual(result[0]["occurrence_probability"], 1)
        self.assertEqual(sum(x["occurrence_probability"] for x in result), 1.75)

    def test_verification_invalidated_by_odds_not_prices(self):
        raw, verification = fixture()
        raw["prices"]["1"]["median7d"] = 123
        self.assertEqual(normalize(raw, verification)["boosters"][0]["issues"], [])
        raw["characters"]["1"]["dropChance"]["a"] = .8
        self.assertIn("verification must be renewed", normalize(raw, verification)["boosters"][0]["issues"][0])

    def test_invalid_distributions_and_references(self):
        for probabilities in ({"1": .8}, {"missing": 1}, {"1": float("nan")}, {"1": -1}):
            with self.subTest(probabilities=probabilities), self.assertRaises(DataError):
                moments({"type": "independent_slots", "slots": [{"draws": 1, "probabilities": probabilities}]}, {"1": {}})
        with self.assertRaises(DataError):
            moments({"type": "moments", "cards": {"1": {"expected_copies": .1, "occurrence_probability": .9}}}, {"1": {}})

    def test_missing_prices_unverified_and_schedule(self):
        raw, verification = fixture()
        raw["prices"].pop("1")
        data = normalize(raw, verification)
        self.assertIsNone(data["cards"][0]["median7d"])
        self.assertTrue(normalize(raw, {"boosters": {}})["boosters"][0]["issues"])
        raw["packs"][0]["schedule"] = {"end": "2026-01-01T00:00:00Z"}
        self.assertFalse(normalize(raw, verification)["boosters"][0]["available"])

    def test_duplicate_records_and_bad_price(self):
        raw, verification = fixture()
        raw["catalog"].append(raw["catalog"][0])
        with self.assertRaises(DataError):
            normalize(raw, verification)
        raw, verification = fixture()
        raw["prices"]["1"]["median7d"] = -1
        with self.assertRaises(DataError):
            normalize(raw, verification)

    def test_idempotent_snapshot_storage(self):
        raw, verification = fixture()
        data = normalize(raw, verification)
        with tempfile.TemporaryDirectory() as temporary:
            with database(Path(temporary) / "data.sqlite") as db:
                save(db, raw, verification, data)
                save(db, raw, verification, data)
                self.assertEqual(db.execute("SELECT count(*) FROM snapshots").fetchone()[0], 1)
                self.assertEqual(db.execute("SELECT count(*) FROM outcomes").fetchone()[0], 6)
                self.assertEqual(json.loads(db.execute("SELECT dataset FROM snapshots").fetchone()[0]), data)

    def test_import_cli_and_failed_refresh_preserves_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "latest.json"
            arguments = ["--database", str(Path(temporary) / "db.sqlite"), "--output", str(output),
                         "--import-raw", str(FIXTURES / "raw.json"), "--verification", str(FIXTURES / "verification.json")]
            self.assertEqual(main(arguments), 0)
            original = output.read_bytes()
            raw, _ = fixture()
            raw["catalog"] = []
            bad = Path(temporary) / "bad.json"
            bad.write_text(json.dumps(raw))
            arguments[arguments.index("--import-raw") + 1] = str(bad)
            self.assertEqual(main(arguments), 2)
            self.assertEqual(output.read_bytes(), original)

    def test_access_denial_stops_without_retry(self):
        with tempfile.TemporaryDirectory() as temporary, database(Path(temporary) / "db") as db:
            calls = []
            def denied(request, timeout):
                calls.append(request.full_url)
                raise urllib.error.HTTPError(request.full_url, 403, "Forbidden", {}, io.BytesIO())
            client = Client(db, opener=denied, sleep=lambda _: None)
            with self.assertRaisesRegex(DataError, "access denied"):
                client.get("/packs")
            self.assertEqual(len(calls), 1)

    def test_retry_after_cache_and_resume(self):
        with tempfile.TemporaryDirectory() as temporary, database(Path(temporary) / "db") as db:
            calls, delays = [], []
            class Response(io.BytesIO):
                headers = {"Content-Type": "application/json"}
            def flaky(request, timeout):
                calls.append(request.full_url)
                if len(calls) == 1:
                    raise urllib.error.HTTPError(request.full_url, 429, "slow down", {"Retry-After": "9"}, io.BytesIO())
                return Response(b'[{"id":1}]')
            client = Client(db, opener=flaky, sleep=delays.append)
            self.assertEqual(client.get("/packs"), [{"id": 1}])
            self.assertIn(9, delays)
            self.assertEqual(Client(db, opener=lambda *_a, **_k: self.fail("cache miss")).get("/packs"), [{"id": 1}])
            self.assertEqual(len(calls), 2)

    def test_har_import_ignores_credentials_and_unrelated_bodies(self):
        raw, _ = fixture()
        entries = []
        for path, body in (("characters", raw["catalog"]), ("packs", raw["packs"]), ("me", {"token": "SECRET"})):
            entries.append({"startedDateTime": raw["collected_at"],
                "request": {"url": "https://kyara.games/api/" + path, "headers": [{"Authorization": "SECRET"}]},
                "response": {"status": 200, "content": {"text": json.dumps(body)}}})
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "test.har"
            path.write_text(json.dumps({"log": {"entries": entries}}))
            result = import_har(path)
            self.assertNotIn("SECRET", json.dumps(result))
            self.assertEqual(result["catalog"], raw["catalog"])

    def test_har_preserves_public_rules_pools_and_embedded_prices(self):
        raw, _ = fixture()
        bodies = {
            "characters": raw["catalog"], "packs": raw["packs"],
            "rates": [{"rarity": "R", "pct": 11.4}],
            "config": {"dropWeights": {"R": 11.4}, "pity": {"threshold": 250}, "unrelated": "DO_NOT_RETAIN"},
            "packs/a/characters": [1, 4],
            "characters/1": {"id": 1, "prices": {"median7d": 10, "median30d": 8}},
            "characters/news": {"id": "news", "samples": []},
        }
        entries = [{"startedDateTime": raw["collected_at"],
            "request": {"url": "https://kyara.games/api/" + path},
            "response": {"status": 200, "content": {"text": json.dumps(body)}}}
            for path, body in bodies.items()]
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "capture.har"
            path.write_text(json.dumps({"log": {"entries": entries}}))
            result = import_har(path)
        self.assertEqual(result["pack_pools"]["a"], [1, 4])
        self.assertEqual(set(result["characters"]), {"1"})
        self.assertEqual(result["rules"]["config"]["pity"], {"threshold": 250})
        self.assertNotIn("DO_NOT_RETAIN", json.dumps(result))
        self.assertEqual(result["prices"]["1"]["median7d"], 10)
        data = normalize(result, {"boosters": {}})
        self.assertEqual(data["coverage"]["captured_pools"], 1)
        self.assertEqual(data["coverage"]["priced_7d"], 1)
        result["pack_pools"]["a"] = [1, 1]
        with self.assertRaises(DataError):
            normalize(result, {"boosters": {}})


@unittest.skipUnless(os.environ.get("KYARA_SOLVER"), "Set KYARA_SOLVER to run C++ integration tests")
class SolverTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.path = self.root / "dataset.json"
        self.data = normalize(*fixture())
        self.write()

    def write(self):
        self.path.write_text(json.dumps(self.data))

    def command(self, *args, expected=0):
        process = subprocess.run([os.environ["KYARA_SOLVER"], *args, "--dataset", str(self.path)], capture_output=True, text=True)
        self.assertEqual(process.returncode, expected, process.stdout + process.stderr)
        return process

    def solve(self, *args, expected=0):
        return json.loads(self.command(*args, "--format", "json", expected=expected).stdout)

    def test_reference_profit_and_completion(self):
        result = self.solve()
        self.assertEqual(result["best"]["id"], "a")
        self.assertEqual(result["best"]["expected_profit"], 90)
        result = self.solve("--universe", "black clover", "--profit-weight", "0")
        self.assertEqual(result["best"]["id"], "b")
        self.assertEqual(result["best"]["expected_distinct_new_cards"], 1.5)

    def test_opening_context_is_reported(self):
        self.data["boosters"][0]["verification"]["opening_context"] = {
            "type": "normal_baseline", "description": "Special mechanics excluded"}
        self.write()
        result = self.solve()
        self.assertEqual(result["best"]["opening_context"]["type"], "normal_baseline")
        self.assertIn("Special mechanics excluded", result["warnings"])

    def test_owned_changes_progress_but_not_profit(self):
        result = self.solve("--universe", "Black Clover", "--profit-weight", "0", "--owned", str(FIXTURES / "owned.json"))
        self.assertEqual(result["best"]["id"], "f")
        before = self.solve()["best"]["expected_profit"]
        after = self.solve("--owned", str(FIXTURES / "owned.json"))["best"]["expected_profit"]
        self.assertEqual(before, after)

    def test_multiple_universes_and_blend(self):
        result = self.solve("--universe", "Black Clover", "--universe", "MaoMao", "--profit-weight", "0.5")
        self.assertEqual(result["missing_target_cards"], 3)
        self.assertEqual(result["best"]["id"], "b")
        self.assertEqual(self.solve("--universe", "Black Clover", "--profit-weight", ".5")["best"]["id"], "a")
        self.assertEqual(self.solve("--universe", "Black Clover", "--profit-weight", ".2")["best"]["id"], "b")

    def test_case_colliding_universes_require_exact_name_only_when_selected(self):
        self.data["cards"][1]["universe"] = "black clover"
        self.write()
        self.assertEqual(self.solve()["best"]["id"], "a")
        result = self.solve("--universe", "Black Clover", "--profit-weight", "0")
        self.assertEqual(result["missing_target_cards"], 1)
        self.command("--universe", "BLACK CLOVER", "--profit-weight", "0", expected=2)

    def test_missing_prices_exclude_only_when_required(self):
        self.data["cards"][0]["median7d"] = None
        self.write()
        result = self.solve()
        self.assertNotIn("a", [x["id"] for x in result["ranking"]])
        result = self.solve("--universe", "Black Clover", "--profit-weight", "0")
        self.assertEqual(result["best"]["id"], "b")
        self.assertIsNone(result["best"]["expected_profit"])

    def test_free_fees_window_and_negative_returns(self):
        result = self.solve("--purchase-mode", "free")
        self.assertEqual(result["best"]["id"], "f")
        self.assertEqual(result["best"]["cost"], 0)
        self.assertIsNone(result["best"]["roi"])
        self.assertEqual(self.solve("--fee", ".1")["best"]["expected_profit"], 79)
        self.assertEqual(self.solve("--median-window", "30d")["best"]["expected_profit"], 78)
        result = self.solve("--fee", "1")
        self.assertFalse(result["recommend_paid_purchase"])

    def test_invalid_options_and_ownership(self):
        for args in (("--profit-weight", "nan"), ("--profit-weight", "2"), ("--profit-weight", "0"),
                     ("--universe", "unknown"), ("--owned", str(self.root / "missing"))):
            self.command(*args, expected=2)
        path = self.root / "owned.json"
        self.command("owned", "add", "--owned", str(path), "--card-id", "1")
        self.assertEqual(json.loads(self.command("owned", "list", "--owned", str(path)).stdout)["owned"], ["1"])
        self.command("owned", "remove", "--owned", str(path), "--card-id", "1")
        self.assertEqual(json.loads(path.read_text())["owned"], [])

    def test_completed_universe_and_no_candidates(self):
        owned = self.root / "owned.json"
        owned.write_text(json.dumps({"schema_version": 1, "owned": ["1", "2"]}))
        result = self.solve("--universe", "Black Clover", "--profit-weight", "0", "--owned", str(owned))
        self.assertEqual(result["missing_target_cards"], 0)
        self.assertEqual(result["best"]["id"], "a")
        self.assertEqual(result["best_score_tie_count"], 4)
        for b in self.data["boosters"]:
            b["available"] = False
        self.write()
        self.assertIsNone(self.solve(expected=3)["best"])

    def test_randomized_cp_sat_matches_exhaustive_scoring(self):
        rng = random.Random(3)
        for _ in range(12):
            alpha = rng.choice([0, .2, .5, .8, 1])
            for booster in self.data["boosters"][:4]:
                booster["cost"] = rng.randrange(1, 100)
            self.write()
            result = self.solve("--universe", "Black Clover", "--profit-weight", str(alpha))
            prices = {c["id"]: c["median7d"] for c in self.data["cards"]}
            values = []
            for booster in self.data["boosters"][:4]:
                profit = sum(o["expected_copies"] * prices[o["card_id"]] for o in booster["outcomes"]) - booster["cost"]
                progress = sum(o["occurrence_probability"] for o in booster["outcomes"] if o["card_id"] in ("1", "2"))
                values.append((booster["id"], profit, progress))
            pmin, pmax = min(v[1] for v in values), max(v[1] for v in values)
            umin, umax = min(v[2] for v in values), max(v[2] for v in values)
            scores = {bid: math.floor(1000000 * (alpha * ((p-pmin)/(pmax-pmin) if pmax>pmin else 0)
                       + (1-alpha) * ((u-umin)/(umax-umin) if umax>umin else 0)) + .5) for bid,p,u in values}
            winner = min(scores, key=lambda bid: (-scores[bid], bid))
            self.assertEqual(result["best"]["id"], winner)
            self.assertEqual(result["best"]["score"], scores[winner])


if __name__ == "__main__":
    unittest.main()
