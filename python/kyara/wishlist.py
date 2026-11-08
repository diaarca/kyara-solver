"""Read-only wishlist and dated median-price capture, independent of booster data."""
import re
from datetime import date

from .dataset import DataError, identifier, indexed, now, number, timestamp


def normalize_price_history(body, cid, card, collected_at):
    if not isinstance(body, dict) or identifier(body.get('characterId')) != cid or not isinstance(body.get('days'), list):
        raise DataError(f'Invalid daily price history for card {cid}')
    seen, days = set(), []
    for row in body['days']:
        if not isinstance(row, dict):
            raise DataError('Invalid daily price row')
        day = row.get('day')
        if not isinstance(day, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', day):
            raise DataError('Invalid daily price date')
        try:
            date.fromisoformat(day)
        except ValueError as exc:
            raise DataError('Invalid daily price date') from exc
        n, median = row.get('n'), row.get('median')
        if day in seen or isinstance(n, bool) or not isinstance(n, int) or not 0 <= n <= 9007199254740991:
            raise DataError('Duplicate day or invalid sale count')
        if 'median' not in row:
            raise DataError('Missing daily median')
        if median is not None:
            number(median, 'daily median')
        seen.add(day)
        days.append({'day': day, 'median': median, 'n': n})
    if not isinstance(card.get('name'), str) or not isinstance(card.get('series'), str):
        raise DataError('Missing wishlist card identity')
    timestamp(collected_at)
    return {'id': cid, 'name': card['name'], 'universe': card['series'], 'collected_at': collected_at,
            'days': sorted(days, key=lambda row: row['day'])}


def collect_wishlist(client):
    catalog = indexed(client.get('/characters', ttl=0), 'catalogue')
    ids = client.get('/me/wishlist', ttl=0)
    if not isinstance(ids, list):
        raise DataError('Wishlist must be an array of card IDs')
    ids = [identifier(cid) for cid in ids]
    if len(ids) != len(set(ids)) or any(not re.fullmatch(r'[0-9]+', cid) or cid not in catalog for cid in ids):
        raise DataError('Unknown or duplicate wishlist card')
    cards = []
    for cid in sorted(ids):
        body = client.get(f'/market/prices/{cid}', ttl=0)
        cards.append(normalize_price_history(body, cid, catalog[cid], now()))
    return {'schema_version': 1, 'collected_at': now(), 'cards': cards}
