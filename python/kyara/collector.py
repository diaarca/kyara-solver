"""Read-only collector. Unknown booster mechanics are never inferred.

Uses only the Python standard library; API responses can also be imported from
a browser. See docs/data.md for the raw and verification formats.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import sqlite3
import sys
import time
import urllib.error
import urllib.request

SCHEMA = 1
BASE = "https://kyara.games/api"
# Only public probability/configuration fields needed by the mathematical model.
CONFIG_FIELDS = ("catalogSize", "dropWeights", "pity", "golden", "godPackChance", "godPackSlots", "recycle")


class DataError(ValueError):
    pass


class SameOriginRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        from urllib.parse import urlsplit
        target = urlsplit(new_url)
        if target.scheme != "https" or target.hostname != "kyara.games" or target.port not in (None, 443):
            raise DataError("Refusing redirect outside Kyara")
        return super().redirect_request(request, fp, code, message, headers, new_url)


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


@contextmanager
def database(path):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path)
    db.executescript("""
        CREATE TABLE IF NOT EXISTS responses (
          path TEXT PRIMARY KEY, fetched_at TEXT NOT NULL, body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS snapshots (
          id TEXT PRIMARY KEY, collected_at TEXT NOT NULL, raw TEXT NOT NULL,
          verification TEXT NOT NULL, dataset TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS cards (
          snapshot_id TEXT, id TEXT, name TEXT, universe TEXT, median7d REAL,
          median30d REAL, PRIMARY KEY(snapshot_id,id));
        CREATE TABLE IF NOT EXISTS boosters (
          snapshot_id TEXT, id TEXT, name TEXT, cost REAL, available INTEGER,
          issues TEXT, PRIMARY KEY(snapshot_id,id));
        CREATE TABLE IF NOT EXISTS outcomes (
          snapshot_id TEXT, booster_id TEXT, card_id TEXT,
          expected_copies REAL, occurrence_probability REAL,
          PRIMARY KEY(snapshot_id,booster_id,card_id));
    """)
    try:
        yield db
    finally:
        db.close()


class Client:
    def __init__(self, db, interval=1.0, refresh=False, opener=None, sleep=time.sleep):
        self.db, self.interval, self.refresh = db, max(1.0, interval), refresh
        self.opener = opener or urllib.request.build_opener(SameOriginRedirect()).open
        self.sleep = sleep
        self.last = None
        self.fetched_at = {}

    def get(self, path, ttl=1800):
        cached = self.db.execute("SELECT fetched_at,body FROM responses WHERE path=?", (path,)).fetchone()
        if cached and not self.refresh and (datetime.now(timezone.utc) - timestamp(cached[0])).total_seconds() < ttl:
            self.fetched_at[path] = cached[0]
            return json.loads(cached[1])
        headers = {"Accept": "application/json", "User-Agent": "kyara-solver/0.1 (read-only collector)"}
        # Read only at request time; never serialize these headers or credentials.
        token = os.environ.get("KYARA_TOKEN")
        if token:
            headers["Authorization"] = "Bearer " + token
        device = os.environ.get("KYARA_DEVICE_ID")
        if device:
            headers["x-device-id"] = device
        for attempt in range(3):
            if self.last is not None:
                self.sleep(max(0, self.interval - (time.monotonic() - self.last)))
            self.last = time.monotonic()
            try:
                with self.opener(urllib.request.Request(BASE + path, headers=headers), timeout=30) as response:
                    content_type = response.headers.get("Content-Type", "")
                    if "json" not in content_type:
                        raise DataError("Non-JSON response: collection paused; use supported browser export")
                    body = json.load(response)
                fetched = now()
                self.db.execute("INSERT OR REPLACE INTO responses VALUES (?,?,?)", (path, fetched, canonical(body)))
                self.db.commit()  # checkpoint every successful request
                self.fetched_at[path] = fetched
                return body
            except urllib.error.HTTPError as exc:
                exc.close()
                if exc.code in (401, 403):
                    raise DataError(f"HTTP {exc.code}: access denied; collection paused. Use browser export or supported access.") from None
                if exc.code == 404:
                    raise
                if exc.code != 429 and exc.code < 500:
                    raise DataError(f"HTTP {exc.code} for {path}") from None
                if attempt == 2:
                    raise DataError(f"HTTP {exc.code}: retry limit reached; successful responses are checkpointed") from None
                retry = exc.headers.get("Retry-After", "") if exc.headers else ""
                try:
                    delay = float(retry)
                except ValueError:
                    from email.utils import parsedate_to_datetime
                    try:
                        delay = (parsedate_to_datetime(retry) - datetime.now(timezone.utc)).total_seconds()
                    except (ValueError, TypeError):
                        delay = 2 ** (attempt + 1)
                self.sleep(max(2 ** (attempt + 1), delay))
            except (urllib.error.URLError, TimeoutError):
                if attempt == 2:
                    raise DataError("Network retry limit reached; rerun to resume checkpointed collection") from None
                self.sleep(2 ** (attempt + 1))
            except json.JSONDecodeError:
                raise DataError("Invalid JSON response; collection paused") from None


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


def collect(client, verification, booster_id=None):
    catalog = client.get("/characters", ttl=86400)
    packs = client.get("/packs", ttl=1800)
    catalog_map, pack_map = indexed(catalog, "catalog"), indexed(packs, "packs")
    if booster_id is not None:
        if booster_id not in pack_map:
            raise DataError(f"Unknown booster ID: {booster_id}")
        definition = verification.get("boosters", {}).get(booster_id)
        if not definition:
            raise DataError("Single-booster collection needs its verified card pool; first export catalogue responses")
        wanted = [x["card_id"] for x in moments(definition["model"], catalog_map)]
    else:
        wanted = sorted(catalog_map)
    raw = {"catalog": catalog, "packs": packs, "characters": {}, "prices": {}}
    for index, cid in enumerate(wanted, 1):
        # IDs come from the server catalogue, but still quote URL path components.
        from urllib.parse import quote
        safe = quote(cid, safe="")
        try:
            raw["characters"][cid] = client.get(f"/characters/{safe}")
        except urllib.error.HTTPError as exc:
            if exc.code != 404:
                raise
        try:
            raw["prices"][cid] = client.get(f"/market/prices/{safe}", ttl=300)
        except urllib.error.HTTPError as exc:
            if exc.code != 404:
                raise
            raw["prices"][cid] = None
        if index % 50 == 0:
            print(f"Collected {index}/{len(wanted)} cards", file=sys.stderr)
    raw["collected_at"] = now()
    raw["fetched_at"] = client.fetched_at
    return raw


def save(db, raw, verification, dataset):
    sid = dataset["snapshot_id"]
    with db:
        db.execute("INSERT OR REPLACE INTO snapshots VALUES (?,?,?,?,?)",
                   (sid, dataset["collected_at"], canonical(raw), canonical(verification), canonical(dataset)))
        db.executemany("INSERT OR REPLACE INTO cards VALUES (?,?,?,?,?,?)",
                       [(sid, c["id"], c["name"], c["universe"], c["median7d"], c["median30d"]) for c in dataset["cards"]])
        db.executemany("INSERT OR REPLACE INTO boosters VALUES (?,?,?,?,?,?)",
                       [(sid, b["id"], b["name"], b["cost"], b["available"], canonical(b["issues"])) for b in dataset["boosters"]])
        db.executemany("INSERT OR REPLACE INTO outcomes VALUES (?,?,?,?,?)",
                       [(sid, b["id"], o["card_id"], o["expected_copies"], o["occurrence_probability"])
                        for b in dataset["boosters"] for o in b["outcomes"]])


def import_har(path):
    """Import response bodies only. Request headers/cookies are deliberately ignored."""
    import base64
    from urllib.parse import urlsplit, unquote
    raw = {"characters": {}, "prices": {}, "pack_pools": {}, "rules": {}, "fetched_at": {}}
    for entry in json.loads(Path(path).read_text())["log"]["entries"]:
        url = urlsplit(entry["request"]["url"])
        if url.scheme != "https" or url.hostname != "kyara.games" or entry["response"]["status"] != 200:
            continue
        path = url.path.removeprefix("/api") if url.path.startswith("/api/") else ""
        parts = path.strip("/").split("/")
        kind = None
        if path in ("/characters", "/packs"):
            kind = "catalog" if path == "/characters" else "packs"
        elif path in ("/rates", "/odds", "/config"):
            kind = "rules"
        elif len(parts) == 3 and parts[0] == "packs" and parts[2] == "characters":
            kind = "pack_pools"
        elif len(parts) == 2 and parts[0] == "characters" and parts[1].isascii() and parts[1].isdigit():
            kind = "characters"
        elif len(parts) == 3 and parts[:2] == ["market", "prices"]:
            kind = "prices"
        if kind is None:
            continue
        content = entry["response"]["content"]
        body = content.get("text", "")
        if content.get("encoding") == "base64":
            body = base64.b64decode(body).decode("utf-8")
        try:
            value = json.loads(body)
        except ValueError:
            raise DataError(f"HAR response for {path} has no JSON body; export with response content") from None
        fetched = entry["startedDateTime"]
        timestamp(fetched)
        if path in raw["fetched_at"] and timestamp(raw["fetched_at"][path]) > timestamp(fetched):
            continue
        if kind in ("catalog", "packs"):
            raw[kind] = value
        elif kind == "rules":
            if path == "/config":
                if not isinstance(value, dict):
                    raise DataError("Public config response must be an object")
                value = {key: value[key] for key in CONFIG_FIELDS if key in value}
            raw["rules"][parts[-1]] = value
        elif kind == "pack_pools":
            raw[kind][unquote(parts[1])] = value
        else:
            raw[kind][unquote(parts[-1])] = value
        raw["fetched_at"][path] = fetched
    if "catalog" not in raw or "packs" not in raw:
        raise DataError("HAR must contain successful /api/characters and /api/packs responses")
    raw["collected_at"] = max(raw["fetched_at"].values(), key=timestamp)
    # Character detail responses can include the same public price summary.
    # Use it only when no equally recent or newer dedicated price response exists.
    for cid, detail in raw["characters"].items():
        if not isinstance(detail, dict) or not isinstance(detail.get("prices"), dict):
            continue
        detail_at = raw["fetched_at"][f"/characters/{cid}"]
        price_path = f"/market/prices/{cid}"
        price_at = raw["fetched_at"].get(price_path)
        if price_at is None or timestamp(detail_at) > timestamp(price_at):
            raw["prices"][cid] = detail["prices"]
            raw["fetched_at"][price_path] = detail_at
    return raw


def main(argv=None):
    parser = argparse.ArgumentParser(description="Update Kyara snapshots; never bypasses access denials.")
    parser.add_argument("--database", default="data/kyara.sqlite")
    parser.add_argument("--output", default="data/latest.json")
    parser.add_argument("--verification", help="Verified booster models JSON (see docs/data.md)")
    parser.add_argument("--verify-baseline", action="append", default=[], metavar="BOOSTER_ID",
                        help="Verify normal-opening base-weight model against every captured card's published odds")
    parser.add_argument("--verification-output", help="Save the verification used for this snapshot")
    imports = parser.add_mutually_exclusive_group()
    imports.add_argument("--import-raw", help="Import saved browser responses instead of accessing Kyara")
    imports.add_argument("--import-har", help="Import allowlisted response bodies from a browser HAR")
    imports.add_argument("--refresh-prices-from", help="Reuse metadata from a raw snapshot and refresh explicit medians in batches")
    imports.add_argument("--full-refresh", action="store_true", help="Collect catalogue, all pools, batch medians, and representative odds samples")
    parser.add_argument("--verify-published-baselines", action="store_true", help="Validate published rates and per-rarity samples for all boosters; report contradictions")
    parser.add_argument("--transport", choices=("auto", "http", "browser"), default="auto", help="Auto uses the authorized macOS browser for batch workflows; HTTP elsewhere")
    parser.add_argument("--batch-size", type=int, default=200)
    parser.add_argument("--fingerprints", action="store_true", help="Print verification fingerprints for imported raw/HAR data without saving")
    parser.add_argument("--raw-output", help="Also save raw responses to this JSON path")
    parser.add_argument("--booster-id", help="Limit live card requests to a verified booster's pool")
    parser.add_argument("--interval", type=float, default=1, help="Seconds between requests (minimum 1)")
    parser.add_argument("--refresh", action="store_true", help="Bypass response cache")
    parser.add_argument("--catalog-only", action="store_true", help="Fetch only catalogues to inspect booster definitions")
    args = parser.parse_args(argv)
    try:
        if not math.isfinite(args.interval) or args.interval < 1:
            raise DataError("--interval must be finite and at least 1 second")
        implicit = not any((args.import_raw, args.import_har, args.refresh_prices_from,
                            args.full_refresh, args.catalog_only, args.booster_id, args.fingerprints))
        if implicit:
            if Path("data/raw.json").exists():
                args.refresh_prices_from = "data/raw.json"
            else:
                args.full_refresh = True
            args.raw_output = args.raw_output or "data/raw.json"
        if args.transport == "auto":
            args.transport = "browser" if sys.platform == "darwin" and (args.full_refresh or args.refresh_prices_from) else "http"
        if (args.full_refresh or args.refresh_prices_from) and not args.verification and Path("data/verification.json").exists():
            args.verification = "data/verification.json"
        if args.full_refresh and not args.verification_output:
            args.verification_output = "data/verification.json"
        verification = json.loads(Path(args.verification).read_text()) if args.verification else {"boosters": {}}
        if args.transport == "browser" and not (args.refresh_prices_from or args.full_refresh):
            raise DataError("Use browser transport with --refresh-prices-from or --full-refresh")
        imported = import_har(args.import_har) if args.import_har else (
            json.loads(Path(args.import_raw).read_text()) if args.import_raw else None)
        if args.fingerprints:
            if imported is None:
                raise DataError("--fingerprints requires --import-raw or --import-har")
            print(json.dumps({identifier(p["id"]): {"pack_sha256": digest(p),
                  "mechanics_sha256": mechanics_digest(imported, identifier(p["id"]))}
                  for p in imported["packs"]}, indent=2, sort_keys=True))
            return 0
        with database(args.database) as db:
            if imported is not None:
                raw = imported
            elif args.full_refresh:
                from .metadata import collect_metadata, collect_odds_samples
                from .batch_prices import refresh_prices
                opener = None
                if args.transport == "browser":
                    from .browser import BrowserOpener
                    opener = BrowserOpener()
                client = Client(db, args.interval, args.refresh, opener=opener)
                raw = collect_odds_samples(client, refresh_prices(client, collect_metadata(client), args.batch_size))
            elif args.refresh_prices_from:
                from .batch_prices import refresh_prices
                opener = None
                if args.transport == "browser":
                    from .browser import BrowserOpener
                    opener = BrowserOpener()
                client = Client(db, args.interval, args.refresh, opener=opener)
                raw = refresh_prices(client, json.loads(Path(args.refresh_prices_from).read_text()), args.batch_size)
            else:
                client = Client(db, args.interval, args.refresh)
                if args.catalog_only:
                    raw = {"catalog": client.get("/characters", 86400), "packs": client.get("/packs"),
                           "collected_at": now(), "fetched_at": client.fetched_at}
                else:
                    raw = collect(client, verification, args.booster_id)
            if args.verify_baseline:
                from .baseline import verify_baseline
                for bid in args.verify_baseline:
                    verification.setdefault("boosters", {})[bid] = verify_baseline(raw, bid)
            if args.verify_published_baselines or args.full_refresh:
                from .baseline import verify_baseline
                raw["baseline_validation_failures"] = {}
                for pack in raw["packs"]:
                    bid = identifier(pack["id"])
                    try:
                        verification.setdefault("boosters", {})[bid] = verify_baseline(raw, bid, published=True)
                    except ValueError as exc:
                        verification.setdefault("boosters", {}).pop(bid, None)
                        raw["baseline_validation_failures"][bid] = str(exc)
            dataset = normalize(raw, verification)
            save(db, raw, verification, dataset)
        if args.raw_output:
            atomic_json(args.raw_output, raw)
        if args.verification_output:
            atomic_json(args.verification_output, verification)
        snapshot_file = Path(args.output).parent / "snapshots" / (dataset["snapshot_id"] + ".json")
        atomic_json(snapshot_file, dataset)
        atomic_json(args.output, dataset)
        complete = sum(not b["issues"] for b in dataset["boosters"])
        print(f"Snapshot {dataset['snapshot_id']}: {len(dataset['cards'])} cards, "
              f"{len(dataset['boosters'])} boosters, {complete} with verified mechanics. Saved {args.output}")
        return 0
    except (DataError, OSError, ValueError, KeyError, TypeError, AttributeError, sqlite3.Error) as exc:
        print(f"scrap: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
