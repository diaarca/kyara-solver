import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

from kyara.collector import normalize


@unittest.skipUnless(os.environ.get('KYARA_SOLVER'), 'Set KYARA_SOLVER to run C++ tests')
class HorizonTests(unittest.TestCase):
    def setUp(self):
        fixtures = Path(__file__).parent / 'fixtures'
        self.data = normalize(json.loads((fixtures/'raw.json').read_text()), json.loads((fixtures/'verification.json').read_text()))
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name)/'data.json'

    def solve(self, *args, code=0):
        self.path.write_text(json.dumps(self.data))
        p = subprocess.run([os.environ['KYARA_SOLVER'], '--dataset', str(self.path), '--format', 'json', *args], capture_output=True, text=True)
        self.assertEqual(p.returncode, code, p.stderr)
        return json.loads(p.stdout) if code == 0 else p.stderr

    def test_defaults_and_profit_totals(self):
        one = self.solve()
        self.assertEqual(one['horizon'], 1)
        self.assertEqual(one['ranking'], self.solve('--horizon', '1')['ranking'])
        many = self.solve('--horizon', '100')
        self.assertEqual(many['best']['id'], one['best']['id'])
        self.assertEqual(many['best']['expected_profit'], 9000)
        self.assertEqual(many['best']['total_cost'], 2000)
        self.assertEqual(many['best']['cost'], 20)
        self.assertEqual(many['best']['roi'], one['best']['roi'])

    def test_completion_saturates(self):
        result = self.solve('--horizon', '100', '--universe', 'Black Clover', '--profit-weight', '0')
        self.assertAlmostEqual(result['best']['expected_distinct_new_cards'], 2)

    def test_invalid_horizons(self):
        for h in ['0', '-1', '1.5', '10001', 'NaN', '2x', '999999999999999999999999']:
            with self.subTest(h=h): self.solve('--horizon', h, code=2)

    def test_exact_cap_two_across_openings(self):
        self.data['cards'] = [{'id':str(i),'name':str(i),'universe':'Test','rarity':'R','median7d':1,'median30d':1} for i in range(1,4)]
        self.data['boosters'] = [{'id':'cap','name':'Cap','cost':1,'available':True,'uses_free_packs':True,'issues':[],
            'outcomes':[{'card_id':str(i),'expected_copies':1,'occurrence_probability':19/27} for i in range(1,4)],
            'verification':{'model':{'type':'independent_slots','slots':[{'draws':3,'probabilities':{str(i):1/3 for i in range(1,4)}}]}}}]
        state = {'schema_version':1,'counting':'unique','next_rebirth':2,'collected_at':'2026-11-07T12:00:00Z','owned':[],
                 'requirements':{r:{'current':0,'target':2 if r=='R' else 0} for r in ['C','U','R','E','L','M']}}
        path = Path(self.tmp.name)/'state.json';path.write_text(json.dumps(state))
        result = self.solve('--horizon','2','--rebirth-state',str(path))
        self.assertAlmostEqual(result['best']['rebirth_progress'],1-1/486)
