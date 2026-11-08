"""Dataset validation, probability moments, and stable snapshot serialization."""
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path

SCHEMA = 1
BASE = "https://kyara.games/api"
# Only public probability/configuration fields needed by the mathematical model.
CONFIG_FIELDS = ("catalogSize", "dropWeights", "pity", "golden", "godPackChance", "godPackSlots", "recycle")


class DataError(ValueError):
    pass


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def mechanics_digest(raw, booster_id):
    """Bind manual verification to catalogue membership and published odds, not prices."""
    catalog = indexed(raw["catalog"], "catalog")
    evidence = {
        "catalog": [{"id": cid, "rarity": c.get("rarity"), "series": c.get("series")}
                    for cid, c in sorted(catalog.items())],
        "drop_chances": {cid: detail.get("dropChance", {}).get(booster_id)
                         for cid, detail in sorted(raw.get("characters", {}).items())},
    }
    if raw.get("rules") or booster_id in raw.get("pack_pools", {}):
        evidence["rules"] = raw.get("rules", {})
        evidence["pack_pool"] = raw.get("pack_pools", {}).get(booster_id)
    return digest(evidence)


def now():
    return datetime.now(timezone.utc).isoformat()


def number(value, label, low=0, high=None):
    if isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value):
        raise DataError(f"{label}: expected a finite number")
    if value < low or (high is not None and value > high):
        raise DataError(f"{label}: out of range")
    return value


def identifier(value):
    if isinstance(value, bool) or not isinstance(value, (str, int)) or not str(value):
        raise DataError("IDs must be nonempty strings or integers")
    return str(value)


def indexed(values, label):
    if not isinstance(values, list):
        raise DataError(f"{label}: expected a JSON array; website schema may have changed")
    out = {}
    for value in values:
        if not isinstance(value, dict) or "id" not in value:
            raise DataError(f"{label}: missing record ID")
        key = identifier(value["id"])
        if key in out:
            raise DataError(f"{label}: duplicate ID {key}")
        out[key] = value
    return out


def timestamp(value):
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if result.tzinfo is None:
            raise ValueError("timezone required")
        return result
    except (ValueError, AttributeError) as exc:
        raise DataError(f"Invalid timestamp: {value!r}") from exc


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True, allow_nan=False) + "\n")
    temporary.replace(path)


def moments(model, catalog):
    """Exact first moments for explicitly verified independent replacement slots."""
    if model.get("type") == "moments":
        outcomes = model.get("cards", {})
        if not isinstance(outcomes, dict) or not outcomes:
            raise DataError("moments: cards must be a nonempty mapping")
        result = []
        for cid, values in sorted(outcomes.items()):
            if cid not in catalog:
                raise DataError(f"Unknown card {cid} in booster mechanics")
            expected = number(values["expected_copies"], "expected_copies")
            occurrence = number(values["occurrence_probability"], "occurrence_probability", high=1)
            if expected < occurrence or (expected > 0) != (occurrence > 0):
                raise DataError("Inconsistent expected copies and occurrence probability")
            result.append({"card_id": cid, "expected_copies": expected, "occurrence_probability": occurrence})
        return result
    if model.get("type") != "independent_slots":
        raise DataError("Mechanics must declare moments or independent_slots")
    slots = model.get("slots", [])
    if not slots:
        raise DataError("No slots in booster mechanics")
    expected, absent = {}, {}
    for slot in slots:
        draws = slot.get("draws")
        if isinstance(draws, bool) or not isinstance(draws, int) or not 1 <= draws <= 10000:
            raise DataError("draws must be an integer in [1,10000]")
        probabilities = slot.get("probabilities", {})
        if not probabilities:
            raise DataError("Empty slot distribution")
        for cid, prob in probabilities.items():
            if cid not in catalog:
                raise DataError(f"Unknown card {cid} in booster mechanics")
            number(prob, "draw probability", high=1)
            expected[cid] = expected.get(cid, 0) + draws * prob
            absent[cid] = absent.get(cid, 1) * (1 - prob) ** draws
        if not math.isclose(sum(probabilities.values()), 1, rel_tol=0, abs_tol=1e-9):
            raise DataError("Slot probabilities must sum to 1")
    return [{"card_id": cid, "expected_copies": expected[cid],
             "occurrence_probability": 1 - absent[cid]} for cid in sorted(expected) if expected[cid] > 0]


def normalize(raw, verification):
    if not isinstance(raw, dict) or not isinstance(verification, dict):
        raise DataError("Raw data and verification must be JSON objects")
    for key in ("characters", "prices", "fetched_at"):
        if not isinstance(raw.get(key, {}), dict):
            raise DataError(f"{key} must be a JSON object")
    for cid, detail in raw.get("characters", {}).items():
        if not isinstance(detail, dict) or not isinstance(detail.get("dropChance", {}), dict):
            raise DataError(f"Character {cid}: invalid detail/dropChance object")
    for cid, price in raw.get("prices", {}).items():
        if price is not None and not isinstance(price, dict):
            raise DataError(f"Card {cid}: price must be an object or null")
    if not isinstance(verification.get("boosters", {}), dict):
        raise DataError("Verification boosters must be a JSON object")
    collected_at = raw["collected_at"]
    instant = timestamp(collected_at)
    catalog = indexed(raw["catalog"], "catalog")
    packs = indexed(raw["packs"], "packs")
    if not catalog or not packs:
        raise DataError("Empty catalogue or booster list; refusing to publish a snapshot")
    verified = verification.get("boosters", {})
    if set(verified) - set(packs):
        raise DataError("Verification references a booster absent from the raw catalogue")
    cards = []
    for cid, card in sorted(catalog.items()):
        if not isinstance(card.get("name"), str) or not isinstance(card.get("series"), str):
            raise DataError(f"Card {cid}: missing name or series")
        price = raw.get("prices", {}).get(cid) or {}
        item = {"id": cid, "name": card["name"], "universe": card["series"],
                "rarity": card.get("rarity"), "price_collected_at": raw.get("fetched_at", {}).get(f"/market/prices/{cid}", collected_at)}
        if cid in raw.get("price_sources", {}):
            item["price_source"] = raw["price_sources"][cid]
        for window in ("median7d", "median30d"):
            item[window] = price.get(window)
            if item[window] is not None:
                number(item[window], f"{cid}.{window}")
        # Preserve reported count names; do not imply a count belongs to a different window.
        item["sales_counts"] = {k: v for k, v in price.items() if "count" in k.lower() or "sales" in k.lower()}
        cards.append(item)
    boosters = []
    for bid, pack in sorted(packs.items()):
        issues = []
        if bid in raw.get("baseline_validation_failures", {}):
            issues.append("baseline validation: " + raw["baseline_validation_failures"][bid])
        cost = pack.get("chakraPrice")
        if cost is None:
            issues.append("missing booster price")
        else:
            number(cost, f"booster {bid} cost")
        schedule = pack.get("schedule") or {}
        available = not pack.get("grantOnly", False)
        if schedule.get("start"):
            available &= timestamp(schedule["start"]) <= instant
        if schedule.get("end"):
            available &= instant < timestamp(schedule["end"])
        definition = verified.get(bid)
        outcomes = []
        if not definition:
            issues.append("unverified card pool and probability semantics")
        elif definition.get("pack_sha256") != digest(pack):
            issues.append("booster definition changed; verification must be renewed")
        elif definition.get("mechanics_sha256") != mechanics_digest(raw, bid):
            issues.append("catalogue or published odds changed; verification must be renewed")
        else:
            if definition.get("pool_complete") is not True or not definition.get("evidence"):
                raise DataError(f"Booster {bid}: complete pool and evidence are required")
            timestamp(definition.get("verified_at"))
            outcomes = moments(definition["model"], catalog)
            # Published dropChance is preserved as evidence, not assumed to be a particular moment.
            for outcome in outcomes:
                detail = raw.get("characters", {}).get(outcome["card_id"], {})
                chance = detail.get("dropChance", {}).get(bid)
                if chance is not None:
                    outcome["published_drop_chance"] = chance
        boosters.append({"id": bid, "name": pack.get("name", bid), "cost": cost,
                         "available": bool(available), "uses_free_packs": bool(pack.get("usesFreePacks", False)),
                         "schedule": schedule, "issues": issues, "outcomes": outcomes,
                         "verification": definition})
    pack_pools = raw.get("pack_pools", {})
    if not isinstance(pack_pools, dict):
        raise DataError("pack_pools must be a JSON object")
    for bid, pool in pack_pools.items():
        if bid not in packs or not isinstance(pool, list):
            raise DataError(f"Invalid booster pool {bid}")
        ids = [identifier(cid) for cid in pool]
        if len(ids) != len(set(ids)) or set(ids) - set(catalog):
            raise DataError(f"Booster {bid}: duplicate or unknown pool card IDs")
        declared = packs[bid].get("rates", {}).get("poolSize")
        if declared is not None and len(ids) != declared:
            raise DataError(f"Booster {bid}: captured pool does not match published poolSize")
    result = {"schema_version": SCHEMA, "collected_at": collected_at,
              "collected_at_unix": int(instant.timestamp()),
              "synthetic": bool(raw.get("synthetic", False)), "cards": cards, "boosters": boosters,
              "source": BASE, "response_timestamps": raw.get("fetched_at", {}),
              "metadata_collected_at": raw.get("metadata_collected_at", collected_at),
              "price_refresh": raw.get("price_refresh"),
              "pack_pools": pack_pools, "rules": raw.get("rules", {}),
              "coverage": {"catalog_cards": len(cards), "boosters": len(boosters),
                           "captured_pools": len(pack_pools),
                           "priced_7d": sum(c["median7d"] is not None for c in cards),
                           "priced_30d": sum(c["median30d"] is not None for c in cards)}}
    result["snapshot_id"] = digest({"raw": raw, "verification": verification})
    return result
