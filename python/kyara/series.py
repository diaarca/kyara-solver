"""Capture completed mission albums, holdings, and costs for new series."""
from collections import Counter

from .batch_prices import parse_prices
from .dataset import DataError, identifier, indexed, now, timestamp
from .rebirth import nonnegative_integer


def collect_series(client):
    catalog = indexed(client.get('/characters', ttl=0), 'catalogue')
    missions = client.get('/me/progress', ttl=0)
    if not isinstance(missions, dict) or not isinstance(missions.get('series'), list):
        raise DataError('Missing completed series in missions')
    completed = set()
    for row in missions['series']:
        if not isinstance(row, dict) or not isinstance(row.get('series'), str) or not row['series'].strip():
            raise DataError('Invalid completed series')
        timestamp(row.get('completedAt'))
        if (nonnegative_integer(row.get('size'), 'Completed series size') < 5
                or not isinstance(row.get('claimed'), bool) or row['series'] in completed):
            raise DataError('Invalid or duplicate completed series')
        completed.add(row['series'])
    inventory = client.get('/me/collection?lean=1', ttl=0)
    items = inventory if isinstance(inventory, list) else inventory.get('items') if isinstance(inventory, dict) else None
    if not isinstance(items, list):
        raise DataError('Invalid collection response')
    seen, owned = set(), set()
    for row in items:
        if not isinstance(row, dict):
            raise DataError('Invalid inventory card')
        cid = identifier(row.get('characterId', row.get('id')))
        if cid not in catalog or cid in seen:
            raise DataError('Unknown or duplicate inventory card; refresh catalogue')
        seen.add(cid)
        if nonnegative_integer(row.get('qty'), 'Quantity') > 0:
            owned.add(cid)
    cards = []
    for cid, card in catalog.items():
        if not isinstance(card.get('name'), str) or not isinstance(card.get('series'), str) or not card['series'].strip():
            raise DataError('Invalid catalogue card')
        cards.append({'id': cid, 'name': card['name'], 'universe': card['series'], 'median7d': None, 'median30d': None})
    counts = Counter(card['universe'] for card in cards)
    remaining = sorted(name for name, count in counts.items() if count >= 5 and name not in completed)
    eligible = set(remaining)
    missing = sorted((card for card in cards if card['universe'] in eligible and card['id'] not in owned), key=lambda c: c['id'])
    if any(not card['id'].isascii() or not card['id'].isdigit() for card in missing):
        raise DataError('Batch prices require numeric card IDs')
    for start in range(0, len(missing), 200):
        batch = missing[start:start + 200]
        ids = [card['id'] for card in batch]
        prices = parse_prices(client.get('/me/collection/prices?ids=' + ','.join(ids), ttl=0), ids)
        for card in batch:
            price = prices.get(card['id'], {})
            card.update({field: price.get(field) for field in ('median7d', 'median30d')})
    return {'schema_version': 1, 'collected_at': now(), 'cards': cards, 'owned': sorted(owned),
            'completed_series': sorted(completed), 'remaining_series': remaining}
