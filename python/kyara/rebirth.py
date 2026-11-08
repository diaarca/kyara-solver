"""Capture only the current rebirth rarity targets and unique-card holdings."""
from .dataset import DataError, identifier, indexed, now, timestamp

RARITY_KEYS = {"C": "C", "U": "U", "R": "R", "E": "E", "legendaries": "L", "mythics": "M"}


def nonnegative_integer(value, label):
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise DataError(f"{label} must be a nonnegative integer")
    return value


def normalize_rebirth(status, inventory, catalog, collected_at):
    timestamp(collected_at)
    cards = indexed(catalog, "catalog")
    if not isinstance(status, dict) or not isinstance(status.get("requirements"), list):
        raise DataError("Unexpected rebirth status response")
    level = nonnegative_integer(status.get("next"), "Next rebirth")
    if level == 0:
        raise DataError("No next rebirth level was provided")
    items = inventory if isinstance(inventory, list) else inventory.get("items") if isinstance(inventory, dict) else None
    if not isinstance(items, list):
        raise DataError("Unexpected collection response")
    counts = {r: 0 for r in RARITY_KEYS.values()}
    owned = set()
    seen = set()
    for item in items:
        if not isinstance(item, dict):
            raise DataError("Unexpected collection record")
        cid = identifier(item.get("characterId", item.get("id")))
        if cid not in cards:
            raise DataError(f"Owned card {cid} is absent from the catalogue; run a full refresh")
        if cid in seen:
            raise DataError(f"Duplicate collection record {cid}")
        seen.add(cid)
        qty = nonnegative_integer(item.get("qty"), "Card quantity")
        rarity = cards[cid].get("rarity")
        if rarity not in counts:
            raise DataError(f"Unknown rarity for owned card {cid}")
        if qty > 0:
            counts[rarity] += 1
            owned.add(cid)
    requirements = {}
    for requirement in status["requirements"]:
        if not isinstance(requirement, dict):
            raise DataError("Invalid rebirth requirement")
        key = requirement.get("key")
        if key not in RARITY_KEYS:
            continue  # Time, boosters opened, escrow, trust, and other conditions.
        rarity = RARITY_KEYS[key]
        if rarity in requirements:
            raise DataError(f"Duplicate rebirth requirement for {rarity}")
        current = nonnegative_integer(requirement.get("have"), f"{rarity} current count")
        target = nonnegative_integer(requirement.get("need"), f"{rarity} target")
        if current != counts[rarity]:
            raise DataError(f"Rebirth count for {rarity} does not match unique holdings; refresh state/catalogue")
        requirements[rarity] = {"current": current, "target": target}
    if set(requirements) != set(counts):
        raise DataError("Rebirth response is missing a rarity-count criterion")
    return {"schema_version": 1, "collected_at": collected_at, "next_rebirth": level,
            "counting": "unique", "requirements": requirements, "owned": sorted(owned)}


def collect_rebirth(client, catalog):
    status = client.get("/me/renaissance?fresh=1", ttl=0)
    inventory = client.get("/me/collection?lean=1", ttl=0)
    return normalize_rebirth(status, inventory, catalog, now())
