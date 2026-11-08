"""Verify an ordinary-opening recipe against a complete captured booster pool.

This establishes only the baseline represented by the public dropChance field.
It does not claim to model golden, pity, or god-pack outcomes.
"""
from collections import Counter
import math

from .dataset import DataError, digest, identifier, indexed, mechanics_digest, moments, number

RARITIES = ("C", "U", "R", "E", "L", "M")


def verify_baseline(raw, booster_id, *, published=False):
    use_published = published
    catalog = indexed(raw["catalog"], "catalog")
    packs = indexed(raw["packs"], "packs")
    if booster_id not in packs:
        raise DataError(f"Unknown booster {booster_id}")
    pack = packs[booster_id]
    if pack.get("rateUp") or pack.get("featuredPity"):
        raise DataError("Boosted or featured-pity mechanics require a separate model")
    pool = [identifier(cid) for cid in raw.get("pack_pools", {}).get(booster_id, [])]
    if not pool or len(pool) != len(set(pool)) or set(pool) - set(catalog):
        raise DataError("Baseline verification needs a complete pool of distinct known cards")
    rates = pack.get("rates", {})
    if rates.get("poolSize") != len(pool):
        raise DataError("Captured card pool does not match published poolSize")
    counts = Counter(catalog[cid]["rarity"] for cid in pool)
    if set(counts) - set(RARITIES):
        raise DataError("Unknown rarity in captured pool")
    for rarity in RARITIES:
        if counts[rarity] != rates.get("cardsByRarity", {}).get(rarity):
            raise DataError(f"Pool rarity count mismatch for {rarity}")
    weights = raw.get("rules", {}).get("config", {}).get("dropWeights", {})
    for rarity in RARITIES:
        number(weights.get(rarity), f"drop weight {rarity}")
    minimums = pack.get("slots", [])
    published_slots = rates.get("slots", [])
    if not minimums or len(minimums) != len(published_slots):
        raise DataError("Missing or inconsistent published slot definitions")
    slot_distributions = []
    rounded_rates = False
    for minimum, published in zip(minimums, published_slots):
        if minimum not in RARITIES or published.get("min") != minimum:
            raise DataError("Invalid minimum rarity or inconsistent published slot")
        allowed = [r for r in RARITIES[RARITIES.index(minimum):] if counts[r]]
        denominator = sum(weights[r] for r in allowed)
        if denominator <= 0:
            raise DataError("Empty supported slot distribution")
        rarity_probabilities = {r: weights[r] / denominator if r in allowed else 0 for r in RARITIES}
        observed_pct = {r: number(published.get("pct", {}).get(r), "published slot percent", high=100) for r in RARITIES}
        mismatch = any(abs(100 * rarity_probabilities[r] - observed_pct[r]) > 0.000050001 for r in RARITIES)
        if mismatch:
            if not use_published:
                raise DataError("Published slot percentages do not match base weights; separate model required")
            total = sum(observed_pct.values())
            if abs(total - 100) > 0.000310001 or any(observed_pct[r] > 0 and r not in allowed for r in RARITIES):
                raise DataError("Invalid published slot distribution")
            rarity_probabilities = {r: observed_pct[r] / total for r in RARITIES}
            rounded_rates = True
        slot_distributions.append(rarity_probabilities)
    model = {"type": "independent_slots", "slots": []}
    grouped = Counter(tuple(slot[r] for r in RARITIES) for slot in slot_distributions)
    for values, draws in grouped.items():
        distribution = dict(zip(RARITIES, values))
        model["slots"].append({"draws": draws, "probabilities": {
            cid: distribution[catalog[cid]["rarity"]] / counts[catalog[cid]["rarity"]]
            for cid in pool if distribution[catalog[cid]["rarity"]] > 0
        }})
    computed = moments(model, catalog)
    if not use_published and {o["card_id"] for o in computed} != set(pool):
        raise DataError("Declared booster pool includes zero-probability cards")
    errors = []
    checked_rarities = set()
    for outcome in computed:
        cid = outcome["card_id"]
        detail = raw.get("characters", {}).get(cid)
        if use_published and detail is None:
            continue
        if not detail or identifier(detail.get("id")) != cid or detail.get("rarity") != catalog[cid]["rarity"]:
            raise DataError(f"Missing or inconsistent captured details for card {cid}")
        observed = number(detail.get("dropChance", {}).get(booster_id), "published card occurrence probability", high=1)
        error = abs(outcome["occurrence_probability"] - observed)
        rarity = catalog[cid]["rarity"]
        tolerance = 4e-6 * len(minimums) / counts[rarity] if rounded_rates else 1e-12
        if error > tolerance:
            raise DataError(f"Published card odds disagree with baseline for card {cid}")
        errors.append(error)
        checked_rarities.add(rarity)
    active_rarities = {catalog[o["card_id"]]["rarity"] for o in computed}
    if use_published and checked_rarities != active_rarities:
        raise DataError("Published-rate validation needs a captured card detail for every pool rarity")
    for rarity in RARITIES:
        published = rates.get("perBooster", {}).get(rarity, {})
        probabilities = [slot[rarity] for slot in slot_distributions]
        expected = sum(probabilities)
        occurrence = 1 - math.prod(1 - p for p in probabilities)
        slot_error = 4e-6 * len(minimums) if rounded_rates else 0
        if abs(number(published.get("expected"), "published rarity expectation") - expected) > 0.000050001 + slot_error:
            raise DataError("Published rarity expectation disagrees with slot model")
        if abs(number(published.get("atLeastOnePct"), "published rarity occurrence", high=100) - 100 * occurrence) > 0.000050001 + 100 * slot_error:
            raise DataError("Published rarity occurrence disagrees with slot model")
        if use_published:
            per_card = 0 if not counts[rarity] else 1 - math.prod(1 - p / counts[rarity] for p in probabilities)
            card_error = 100 * slot_error / counts[rarity] if counts[rarity] else 0
            if abs(number(published.get("perCardPct"), "published per-card occurrence", high=100) - 100 * per_card) > 0.000050001 + card_error:
                raise DataError("Published per-card rates disagree with the within-rarity uniform model")
    return {
        "pack_sha256": digest(pack), "mechanics_sha256": mechanics_digest(raw, booster_id),
        "pool_complete": True, "verified_at": raw["collected_at"],
        "evidence": ("Complete pool/counts, published slot/rarity/per-card rates, and representative details for each rarity; "
                     "independent replacement draws and uniform selection within rarity are the baseline assumptions."
                     if use_published else "Complete captured pool/counts, all slot rates, rarity expectations/occurrences, "
                     "and every per-card dropChance checked against base-weight independent replacement draws."),
        "validation": {"checked_cards": len(errors), "pool_cards": len(pool),
                       "level": "published_rates_with_rarity_samples" if use_published else "all_card_details",
                       "probability_precision": "rounded_published_slot_rates" if rounded_rates else "base_weights",
                       "maximum_probability_error": max(errors)},
        "opening_context": {
            "type": "normal_baseline", "excluded_mechanics": ["golden", "pity", "god_pack"],
            "description": "Normal-opening baseline only; golden, pity and god-pack effects are excluded."
                           + (" Probabilities use rounded published slot rates." if rounded_rates else "")
        },
        "model": model,
    }
