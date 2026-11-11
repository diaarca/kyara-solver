import copy
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
import urllib.request
from unittest.mock import patch

from kyara.browser import BrowserOpener
from kyara.collector import DataError, main
from kyara.series import collect_series

FIXTURE = json.loads((Path(__file__).parent / 'fixtures/series.json').read_text())


class SeriesCaptureTests(unittest.TestCase):
    def test_browser_transport_allows_mission_reads_but_rejects_claims(self):
        replies = iter(['started', '{"done":true,"status":200,"body":{"series":[]}}'])
        opener = BrowserOpener(runner=lambda *_: next(replies))
        with opener(urllib.request.Request('https://kyara.games/api/me/progress')) as response:
            self.assertEqual(json.load(response), {'series': []})
        for request in [urllib.request.Request('https://kyara.games/api/me/progress/claim'),
                        urllib.request.Request('https://kyara.games/api/me/progress', method='POST')]:
            with self.assertRaises(DataError):
                opener(request)

    def client(self, fixture=None):
        state = fixture or FIXTURE
        calls = []

        class Client:
            def get(self, path, ttl=0):
                calls.append(path)
                if path == '/characters':
                    return [dict(id=c['id'], name=c['name'], series=c['universe']) for c in state['cards']]
                if path == '/me/progress':
                    return {'series': [dict(series=n, size=5, completedAt=state['collected_at'], claimed=False) for n in state['completed_series']],
                            'private': 'must not export'}
                if path == '/me/collection?lean=1':
                    return [dict(characterId=c['id'], qty=2 if c['id'] in state['owned'] else 0) for c in state['cards']]
                if path.startswith('/me/collection/prices?ids='):
                    ids = path.split('=')[1].split(',')
                    return [dict(characterId=c['id'], median7d=c['median7d'], median30d=c['median30d']) for c in state['cards'] if c['id'] in ids]
                raise DataError('Unexpected route')

        return Client(), calls

    def test_missions_exclude_unclaimed_completions_and_prices_only_cover_missing_eligible_cards(self):
        client, calls = self.client()
        state = collect_series(client)
        self.assertEqual(state['remaining_series'], FIXTURE['remaining_series'])
        self.assertEqual(state['completed_series'], ['Done'])
        self.assertEqual(state['owned'], FIXTURE['owned'])
        self.assertEqual(calls[:3], ['/characters', '/me/progress', '/me/collection?lean=1'])
        self.assertEqual(set(calls[3].split('=')[1].split(',')), {'5', '6', '7', '8', '9', '10', '20', '21', '22', '23', '24'})
        self.assertNotIn('must not export', json.dumps(state))
        self.assertIsNone(state['cards'][0]['median7d'])

    def test_unknown_missions_and_inventory_fail_closed(self):
        for path, body in [('/me/progress', {}), ('/me/progress', {'series': [{'series': 'Done'}]}),
                           ('/me/collection?lean=1', [{'characterId': '999', 'qty': 1}])]:
            client, _ = self.client()
            original = client.get
            client.get = lambda p, ttl=0: body if p == path else original(p, ttl)
            with self.assertRaises(DataError):
                collect_series(client)

    def test_prices_are_batched_and_no_prices_needed_when_all_completed(self):
        fixture = copy.deepcopy(FIXTURE)
        fixture['cards'] = [dict(id=str(i), name=str(i), universe='Large', median7d=1, median30d=1) for i in range(1, 402)]
        fixture['owned'] = []
        client, calls = self.client(fixture)
        self.assertEqual(collect_series(client)['remaining_series'], ['Large'])
        self.assertEqual([len(path.split('=')[1].split(',')) for path in calls[3:]], [200, 200, 1])
        fixture['completed_series'] = ['Large']
        client, calls = self.client(fixture)
        self.assertEqual(collect_series(client)['remaining_series'], [])
        self.assertEqual(len(calls), 3)

    def test_failed_sync_preserves_previous_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'series.json'
            path.write_text(json.dumps(FIXTURE))
            original = path.read_bytes()
            with patch('kyara.series.collect_series', side_effect=DataError('offline')):
                self.assertEqual(main(['--series-state', str(path), '--database', str(Path(directory) / 'db.sqlite'), '--transport', 'http']), 2)
            self.assertEqual(path.read_bytes(), original)


@unittest.skipUnless(os.environ.get('KYARA_SOLVER'), 'Set KYARA_SOLVER for C++ tests')
class SeriesSolverTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / 'series.json'
        self.data = copy.deepcopy(FIXTURE)

    def solve(self, *args, code=0):
        self.path.write_text(json.dumps(self.data))
        p = subprocess.run([os.environ['KYARA_SOLVER'], 'series', '--series-state', str(self.path), '--format', 'json', *args], capture_output=True, text=True)
        self.assertEqual(p.returncode, code, p.stderr)
        return json.loads(p.stdout) if code == 0 else p.stderr

    def test_total_remaining_cost_and_price_window(self):
        result = self.solve()
        self.assertEqual(result['best']['universe'], 'Almost there')
        self.assertEqual(result['best']['total_cost'], 9)
        self.assertEqual(result['best']['missing_cards'][0]['id'], '5')
        self.assertEqual(self.solve('--median-window', '30d')['best']['universe'], 'From scratch')
        self.assertEqual(len(result['excluded']), 3)

    def test_no_purchase_if_ready_and_empty(self):
        self.data['owned'].append('5')
        self.assertEqual(self.solve()['status'], 'SERIES_READY')
        self.data.update(cards=[], owned=[], remaining_series=[])
        self.assertEqual(self.solve()['status'], 'NO_ELIGIBLE_SERIES')

    def test_invalid_or_inconsistent_snapshots(self):
        self.solve('--median-window', '1d', code=2)
        self.data['remaining_series'] = []
        self.solve(code=2)
        self.data = copy.deepcopy(FIXTURE)
        self.data['cards'][0]['median7d'] = -1
        self.solve(code=2)
