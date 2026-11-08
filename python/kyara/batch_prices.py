"""Strict exact-median batch import; fair-price estimates are not accepted."""
from copy import deepcopy
import time

from .dataset import DataError, identifier, indexed, now, number

ROUTE = "/me/collection/prices"


def parse_prices(body, requested):
    requested = set(requested)
    if isinstance(body, dict) and isinstance(body.get("items"), list):
        rows = body["items"]
    elif isinstance(body, list):
        rows = body
    elif isinstance(body, dict):
        rows = []
        for cid, value in body.items():
            if not isinstance(value, dict):
                raise DataError("Batch response is not an explicit median-price feed; refusing scalar/fair prices")
            rows.append({"id": cid, **value})
    else:
        raise DataError("Unexpected batch-price response shape")
    result = {}
    for row in rows:
        if not isinstance(row, dict):
            raise DataError("Invalid batch-price row")
        cid = identifier(row.get("characterId", row.get("id")))
        if cid not in requested or cid in result:
            raise DataError("Batch price response contains unexpected or duplicate card IDs")
        price = {"characterId": cid}
        for window in ("median7d", "median30d"):
            if window not in row:
                raise DataError("Batch row omits an explicit median window; refusing to infer its meaning")
            value = row[window]
            if value is not None:
                number(value, window)
            price[window] = value
        for field in ("sales7d", "sales30d"):
            if field in row:
                value = row[field]
                if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                    raise DataError(f"Invalid {field}")
                price[field] = value
        result[cid] = price
    return result


def refresh_prices(client, previous, batch_size=200):
    started = time.monotonic()
    if not 1 <= batch_size <= 200:
        raise DataError("Batch size must be between 1 and 200")
    ids = sorted(indexed(previous["catalog"], "catalog"))
    if not ids or any(not cid.isascii() or not cid.isdigit() for cid in ids):
        raise DataError("Batch requests require numeric catalogue IDs")
    raw = deepcopy(previous)
    raw.setdefault("metadata_collected_at", previous.get("price_refresh", {}).get("metadata_collected_at") or previous.get("collected_at"))
    # A new full refresh must never pass old prices off as new observations.
    raw["prices"] = {}
    raw["price_sources"] = {}
    raw.setdefault("fetched_at", {})
    for path in list(raw["fetched_at"]):
        if path.startswith("/market/prices/") or path.startswith(ROUTE + "?"):
            del raw["fetched_at"][path]
    requested_at = now()
    for start in range(0, len(ids), batch_size):
        batch = ids[start:start + batch_size]
        path = ROUTE + "?ids=" + ",".join(batch)
        rows = parse_prices(client.get(path, ttl=0), batch)
        fetched = client.fetched_at[path]
        raw["fetched_at"][path] = fetched
        for cid, price in rows.items():
            raw["prices"][cid] = price
            raw["price_sources"][cid] = ROUTE
            raw["fetched_at"][f"/market/prices/{cid}"] = fetched
    raw["collected_at"] = now()
    missing = sorted(set(ids) - set(raw["prices"]))
    raw["price_refresh"] = {"route": ROUTE, "requested_at": requested_at,
        "finished_at": raw["collected_at"], "requested_cards": len(ids),
        "returned_cards": len(raw["prices"]), "missing_card_ids": missing,
        "batch_size": batch_size, "batch_requests": (len(ids) + batch_size - 1) // batch_size,
        "elapsed_seconds": round(time.monotonic() - started, 3),
        "metadata_collected_at": raw.get("metadata_collected_at"),
        "complete_response_coverage": not missing}
    return raw
