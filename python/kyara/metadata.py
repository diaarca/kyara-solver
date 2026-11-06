"""Collect static booster data and a bounded set of odds-validation samples."""
import time

from .collector import CONFIG_FIELDS, DataError, identifier, indexed, now


def collect_metadata(client):
    started = time.monotonic()
    raw = {"catalog": client.get("/characters", ttl=0), "packs": client.get("/packs", ttl=0),
           "rules": {}, "pack_pools": {}, "characters": {}, "prices": {}}
    catalog = indexed(raw["catalog"], "catalog")
    packs = indexed(raw["packs"], "packs")
    raw["rules"]["rates"] = client.get("/rates", ttl=0)
    config = client.get("/config", ttl=0)
    raw["rules"]["config"] = {k: config[k] for k in CONFIG_FIELDS if k in config}
    for bid, pack in packs.items():
        pool = client.get(f"/packs/{bid}/characters", ttl=0)
        if not isinstance(pool, list):
            raise DataError(f"Invalid pool response for {bid}")
        ids = [identifier(cid) for cid in pool]
        if len(ids) != len(set(ids)) or set(ids) - set(catalog):
            raise DataError(f"Unknown or duplicate pool cards for {bid}")
        if len(ids) != pack.get("rates", {}).get("poolSize"):
            raise DataError(f"Incomplete pool for {bid}")
        raw["pack_pools"][bid] = pool
    raw["collected_at"] = now()
    raw["metadata_collected_at"] = raw["collected_at"]
    raw["metadata_collection_seconds"] = round(time.monotonic() - started, 3)
    raw["fetched_at"] = dict(client.fetched_at)
    return raw


def collect_odds_samples(client, raw):
    started = time.monotonic()
    catalog = indexed(raw["catalog"], "catalog")
    wanted = set()
    for pool in raw["pack_pools"].values():
        represented = set()
        for cid in map(identifier, pool):
            rarity = catalog[cid]["rarity"]
            if rarity not in represented:
                represented.add(rarity)
                wanted.add(cid)
    for cid in sorted(wanted):
        raw["characters"][cid] = client.get(f"/characters/{cid}", ttl=0)
        raw["fetched_at"][f"/characters/{cid}"] = client.fetched_at[f"/characters/{cid}"]
    raw["odds_sample_collection"] = {"cards": len(wanted),
        "elapsed_seconds": round(time.monotonic() - started, 3), "finished_at": now()}
    raw["collected_at"] = now()
    return raw
