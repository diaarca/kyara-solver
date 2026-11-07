import copy
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from kyara.collector import DataError, main
from kyara.wishlist import collect_wishlist

FIXTURE = json.loads((Path(__file__).parent/'fixtures/wishlist.json').read_text())


class WishlistCaptureTests(unittest.TestCase):
    def client(self):
        calls = []
        class Client:
            def get(self, path, ttl=0):
                calls.append(path)
                if path == '/characters': return [{'id':1,'name':'Test','series':'Fixture'}]
                if path == '/me/wishlist': return [1]
                if path == '/market/prices/1': return {'characterId':1,'days':FIXTURE['cards'][0]['days'],'token':'must not export'}
                raise DataError('Unexpected route')
        return Client(), calls

    def test_readonly_capture_without_market_bootstrap(self):
        client,calls = self.client()
        state = collect_wishlist(client)
        self.assertEqual(calls,['/characters','/me/wishlist','/market/prices/1'])
        self.assertNotIn('must not export',json.dumps(state))
        self.assertEqual(state['cards'][0]['id'],'1')

    def test_failed_sync_preserves_previous_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'wishlist.json';path.write_text(json.dumps(FIXTURE));original=path.read_bytes()
            with patch('kyara.wishlist.collect_wishlist',side_effect=DataError('offline')):
                self.assertEqual(main(['--wishlist-state',str(path),'--database',str(Path(directory)/'db.sqlite'),'--transport','http']),2)
            self.assertEqual(path.read_bytes(),original)

    def test_bad_daily_history_stops_capture(self):
        client,_ = self.client()
        real = client.get
        def invalid(path,ttl=0):
            value=real(path,ttl)
            if path.startswith('/market/prices/'):
                value['days']=copy.deepcopy(value['days']);value['days'][0]['day']='2026-02-30'
            return value
        client.get=invalid
        with self.assertRaises(DataError):collect_wishlist(client)


@unittest.skipUnless(os.environ.get('KYARA_SOLVER'),'Set KYARA_SOLVER for C++ tests')
class WishlistSolverTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.path=Path(self.tmp.name)/'wishlist.json';self.data=copy.deepcopy(FIXTURE)

    def solve(self,*args,code=0):
        self.path.write_text(json.dumps(self.data))
        p=subprocess.run([os.environ['KYARA_SOLVER'],'wishlist','--wishlist-state',str(self.path),'--format','json',*args],capture_output=True,text=True)
        self.assertEqual(p.returncode,code,p.stderr)
        return json.loads(p.stdout) if code==0 else p.stderr

    def test_metric_period_and_partial_day(self):
        r=self.solve();self.assertEqual(r['best']['id'],'2');self.assertEqual(r['best']['increase_percent'],200)
        self.assertEqual(self.solve('--metric','absolute')['best']['id'],'1')
        self.assertEqual(self.solve('--lookback-days','30')['best']['elapsed_days'],8)
        self.assertEqual(r['window_end'],'2026-11-06')

    def test_no_upward_signal_and_empty(self):
        self.data['cards']=[self.data['cards'][2]];self.assertEqual(self.solve()['status'],'NO_RISING_CARDS')
        self.data['cards']=[];self.assertIsNone(self.solve()['best'])

    def test_invalid_input(self):
        self.solve('--lookback-days','2',code=2)
        self.solve('--metric','forecast',code=2)
        self.data['cards'][0]['days'][0]['n']=-1;self.solve(code=2)
