import copy
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from kyara.collector import DataError, main, moments, normalize
from kyara.rebirth import normalize_rebirth, collect_rebirth

RARITIES = ("C", "U", "R", "E", "L", "M")
FIXTURES = Path(__file__).parent / "fixtures"


def fixtures():
    raw = json.loads((FIXTURES / "raw.json").read_text())
    verification = json.loads((FIXTURES / "verification.json").read_text())
    return raw, verification


class RebirthCaptureTests(unittest.TestCase):
    def status(self):
        keys = ("C", "U", "R", "E", "legendaries", "mythics")
        return {"next": 9, "requirements": [
            {"key": key, "have": 1 if key in ("R", "mythics") else 0, "need": 3}
            for key in keys] + [{"key": "wait", "have": 0, "need": 99}]}

    def test_capture_uses_unique_counts_dynamic_targets_and_only_rarity_criteria(self):
        raw, _ = fixtures()
        inventory = [{"characterId": 1, "qty": 5}, {"characterId": 4, "qty": 2}]
        state = normalize_rebirth(self.status(), inventory, raw["catalog"], "2026-11-06T12:00:00Z")
        self.assertEqual(state["owned"], ["1", "4"])
        self.assertEqual(state["next_rebirth"], 9)
        self.assertEqual(set(state["requirements"]), set(RARITIES))
        self.assertEqual(state["requirements"]["R"], {"current": 1, "target": 3})

    def test_capture_rejects_missing_criteria_unknown_cards_and_inconsistent_counts(self):
        raw, _ = fixtures()
        inventory = [{"characterId": 1, "qty": 5}, {"characterId": 4, "qty": 2}]
        for change in ("missing", "mismatch", "unknown", "duplicates"):
            status, items = self.status(), copy.deepcopy(inventory)
            if change == "missing": status["requirements"].pop(0)
            elif change == "mismatch": status["requirements"][2]["have"] = 5
            elif change == "unknown": items.append({"characterId": "missing", "qty": 1})
            else: items.append(items[0])
            with self.subTest(change=change), self.assertRaises(DataError):
                normalize_rebirth(status, items, raw["catalog"], "2026-11-06T12:00:00Z")

    def test_capture_makes_only_two_read_only_requests(self):
        raw, _ = fixtures()
        calls = []
        status = self.status()
        class Client:
            def get(self, path, ttl):
                calls.append((path, ttl))
                return status if "renaissance" in path else [{"characterId": 1, "qty": 5}, {"characterId": 4, "qty": 2}]
        collect_rebirth(Client(), raw["catalog"])
        self.assertEqual(calls, [("/me/renaissance?fresh=1", 0), ("/me/collection?lean=1", 0)])

    def test_cli_state_sync_does_not_refresh_prices_or_overwrite_state_on_failure(self):
        raw, _ = fixtures()
        state = normalize_rebirth(self.status(), [{"characterId": 1, "qty": 5}, {"characterId": 4, "qty": 2}],
                                  raw["catalog"], "2026-11-06T12:00:00Z")
        original = os.getcwd()
        with tempfile.TemporaryDirectory() as directory:
            try:
                os.chdir(directory)
                Path("data").mkdir()
                Path("data/raw.json").write_text(json.dumps(raw))
                with patch("kyara.rebirth.collect_rebirth", return_value=state), patch("kyara.batch_prices.refresh_prices") as prices:
                    self.assertEqual(main(["--rebirth-state", "data/rebirth.json", "--transport", "http"]), 0)
                    prices.assert_not_called()
                saved = Path("data/rebirth.json").read_bytes()
                with patch("kyara.rebirth.collect_rebirth", side_effect=DataError("Counts changed")):
                    self.assertEqual(main(["--rebirth-state", "data/rebirth.json", "--transport", "http"]), 2)
                self.assertEqual(Path("data/rebirth.json").read_bytes(), saved)
                self.assertFalse(Path("data/latest.json").exists())
            finally:
                os.chdir(original)


@unittest.skipUnless(os.environ.get("KYARA_SOLVER"), "Set KYARA_SOLVER to run C++ tests")
class RebirthSolverTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.data = normalize(*fixtures())
        self.state = {"schema_version": 1, "counting": "unique", "collected_at": "2026-11-06T12:00:00Z",
                      "next_rebirth": 2, "owned": ["1"], "requirements": {
                          r: {"current": 1 if r == "R" else 0,
                              "target": 2 if r == "R" else 1 if r == "M" else 0} for r in RARITIES}}

    def solve(self, *args, expected=0):
        dataset, state = self.root / "dataset.json", self.root / "rebirth.json"
        dataset.write_text(json.dumps(self.data))
        state.write_text(json.dumps(self.state))
        result = subprocess.run([os.environ["KYARA_SOLVER"], "--dataset", str(dataset),
            "--rebirth-state", str(state), "--format", "json", *args], capture_output=True, text=True)
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        return json.loads(result.stdout) if result.returncode != 2 else result.stderr

    def custom_mythic_pack(self, probabilities, draws, target):
        for cid in probabilities:
            if cid not in {c["id"] for c in self.data["cards"]}:
                card = copy.deepcopy(self.data["cards"][-1])
                card.update(id=cid, rarity="M")
                self.data["cards"].append(card)
        model = {"type": "independent_slots", "slots": [{"draws": draws, "probabilities": probabilities}]}
        self.data["boosters"] = [{"id": "x", "name": "Capped pack", "cost": 1,
            "available": True, "uses_free_packs": True, "issues": [], "verification": {"model": model},
            "outcomes": moments(model, {c["id"]: c for c in self.data["cards"]})}]
        self.state["owned"] = []
        self.state["requirements"] = {r: {"current": 0, "target": target if r == "M" else 0} for r in RARITIES}

    def test_default_rebirth_objective_differs_from_profit_and_can_be_blended(self):
        result = self.solve()
        self.assertEqual(result["best"]["id"], "f")
        self.assertEqual(result["profit_weight"], 0)
        self.assertEqual(result["progress_objective"], "rebirth")
        self.assertEqual(result["best"]["rebirth_progress"], .5)
        self.assertEqual(self.solve("--profit-weight", "1")["best"]["id"], "a")
        self.assertEqual(self.solve("--profit-weight", ".5")["best"]["id"], "a")

    def test_one_remaining_mythic_caps_expected_progress_at_probability_of_any(self):
        self.custom_mythic_pack({"4": .25, "5": .25, "1": .5}, 2, 1)
        row = self.solve()["best"]["rebirth_by_rarity"]["M"]
        self.assertAlmostEqual(row["expected_distinct_new_cards"], .875)
        self.assertAlmostEqual(row["expected_credited_cards"], .75)

    def test_cap_two_tracks_distinct_cards_instead_of_clipping_the_mean(self):
        self.custom_mythic_pack({"4": 1/3, "5": 1/3, "6": 1/3}, 3, 2)
        row = self.solve()["best"]["rebirth_by_rarity"]["M"]
        self.assertAlmostEqual(row["expected_distinct_new_cards"], 19/9)
        self.assertAlmostEqual(row["expected_credited_cards"], 17/9)

    def test_completed_rarity_and_owned_duplicates_do_not_earn_progress(self):
        self.state["requirements"]["R"]["target"] = 1
        result = self.solve()
        self.assertEqual(result["best"]["id"], "a")
        self.assertAlmostEqual(result["best"]["rebirth_progress"], .75)
        row = next(r for r in result["ranking"] if r["id"] == "b")
        self.assertEqual(row["rebirth_by_rarity"]["R"]["expected_credited_cards"], 0)

    def test_missing_prices_do_not_block_pure_rebirth_mode(self):
        for card in self.data["cards"]: card["median7d"] = None
        self.assertEqual(self.solve()["best"]["id"], "f")
        self.assertIsNone(self.solve()["best"]["expected_profit"])
        self.assertIsNone(self.solve("--profit-weight", ".5", expected=3)["best"])

    def test_all_rarity_targets_met_is_not_a_rebirth_eligibility_claim(self):
        for row in self.state["requirements"].values(): row["target"] = row["current"]
        result = self.solve()
        self.assertEqual(result["status"], "REBIRTH_RARITY_TARGETS_MET")
        self.assertTrue(result["rebirth"]["rarity_targets_met"])
        self.assertIsNone(result["best"])
        self.assertNotIn("eligible", result["rebirth"])

    def test_invalid_state_and_conflicting_filters_fail_clearly(self):
        self.assertIn("cannot be combined", self.solve("--universe", "Black Clover", expected=2))
        self.state["requirements"]["R"]["current"] = 2
        self.assertIn("disagree", self.solve(expected=2))
        self.state["requirements"]["R"]["current"] = 1
        self.state["requirements"]["M"]["target"] = 1.5
        self.assertIn("integer", self.solve(expected=2))

    def test_marginals_alone_cannot_establish_capped_progress(self):
        self.custom_mythic_pack({"4": .5, "5": .5}, 2, 1)
        self.data["boosters"][0]["verification"]["model"] = {"type": "moments"}
        result = self.solve(expected=3)
        self.assertIn("independent-slot", str(result["excluded"]))
        self.assertIsNotNone(self.solve("--profit-weight", "1")["best"])


if __name__ == "__main__":
    unittest.main()
