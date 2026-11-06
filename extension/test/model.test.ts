import { test } from 'node:test';
import assert from 'node:assert/strict';
import loadHighs from 'highs';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { solve, validateDataset, validateRebirth } from '../src/model';
import { type Dataset, type Options, RARITIES } from '../src/types';
import { fixture, options, rebirth } from './helpers';
const highs = await loadHighs();
const data = fixture();
const run = (o: Partial<Options> = {}, d = data) => solve(highs, d, options(o));

test('HiGHS solves the explicit binary model and hand-checked profit', () => {
  const r = run(); assert.equal(r.status, 'OPTIMAL'); assert.equal(r.best!.id, 'a');
  assert.equal(r.best!.expected_profit, 90); assert.match(r.model, /Binary/); assert.match(r.model, /choose_one: .* = 1/);
});
test('completion excludes owned cards and counts duplicates once', () => {
  const r = run({ goal: 'collection', weight: 0, universes: ['Black Clover'] });
  assert.equal(r.best!.id, 'b'); assert.equal(r.best!.progress, 1.5);
  const owned = run({ goal: 'collection', weight: 0, universes: ['Black Clover'], owned: ['1'] });
  assert.equal(owned.best!.id, 'f'); assert.equal(owned.best!.progress, 1);
});
test('free eligibility, fees, and median window', () => {
  assert.equal(run({ mode: 'free' }).best!.id, 'f'); assert.equal(run({ mode: 'free' }).best!.cost, 0);
  assert.equal(run({ fee: .1 }).best!.expected_profit, 79);
  assert.equal(run({ window: '30d' }).best!.expected_profit, 78);
});
test('mixed objectives and deterministic tie-break', () => {
  const r = run({ goal: 'collection', weight: .5, universes: ['Black Clover'] }); assert.equal(r.best!.id, 'a');
  const d = structuredClone(data); d.boosters = [d.boosters[0], { ...d.boosters[0], id: 'aaa' }];
  assert.equal(run({}, d).best!.id, 'a');
});
test('missing prices exclude profit but allow pure progress', () => {
  const d = structuredClone(data); d.cards.forEach(c => c.median7d = null);
  assert.equal(run({}, d).status, 'NO_ELIGIBLE_BOOSTER');
  assert.equal(run({ goal: 'collection', weight: 0, universes: ['Black Clover'] }, d).best!.id, 'b');
});
test('negative paid profit produces no-purchase recommendation', () => {
  const d = structuredClone(data); d.boosters.forEach(b => b.cost = 1000);
  assert.equal(run({}, d).recommend_paid_purchase, false);
});
test('rebirth capped expectation and duplicate exclusion', () => {
  const r = run({ goal: 'rebirth', weight: 0, rebirth: rebirth() });
  assert.equal(r.best!.id, 'f'); assert.equal(r.best!.progress, .5);
  assert.equal(r.ranking.find(b => b.id === 'a')!.progress, .375);
});
test('cap two computes E[min(K,2)] rather than clipping E[K]', () => {
  const d: Dataset = structuredClone(data);
  d.cards = [1, 2, 3].map(id => ({ id: String(id), name: String(id), universe: 'Test', rarity: 'R', median7d: 1, median30d: 1 }));
  const model = { type: 'independent_slots', slots: [{ draws: 3, probabilities: { '1': 1/3, '2': 1/3, '3': 1/3 } }] };
  d.boosters = [{ id: 'cap', name: 'Cap', cost: 1, available: true, uses_free_packs: true, issues: [], verification: { model },
    outcomes: d.cards.map(c => ({ card_id: c.id, expected_copies: 1, occurrence_probability: 19/27 })) }];
  const state = rebirth(); state.owned = []; for (const r of RARITIES) state.requirements[r] = { current: 0, target: r === 'R' ? 2 : 0 };
  const r = run({ goal: 'rebirth', weight: 0, rebirth: state }, d);
  assert.ok(Math.abs(r.best!.progress - 17/18) < 1e-12);
});
test('completed rarity targets return no recommendation', () => {
  const state = rebirth(); for (const r of RARITIES) state.requirements[r].target = state.requirements[r].current;
  const r = run({ goal: 'rebirth', weight: 0, rebirth: state });
  assert.equal(r.status, 'REBIRTH_RARITY_TARGETS_MET'); assert.equal(r.best, null);
});
test('reject malformed datasets, state, and parameters', () => {
  const d = structuredClone(data); d.boosters[0].outcomes[0].expected_copies = .01;
  assert.throws(() => validateDataset(d));
  assert.throws(() => run({ fee: -1 })); assert.throws(() => run({ goal: 'collection', weight: 0 }));
  const state = rebirth(); state.requirements.R.current = 99;
  assert.throws(() => validateRebirth(state, new Map(data.cards.map(c => [c.id, c]))));
});
test('moments-only models cannot supply binding cap information', () => {
  const d = structuredClone(data), state = rebirth(); state.owned = []; state.requirements.R = { current: 0, target: 1 };
  const b = d.boosters.find(b => b.id === 'b')!;
  b.verification!.model = { type: 'moments', cards: Object.fromEntries(b.outcomes.map(o => [o.card_id, o])) };
  const r = run({ goal: 'rebirth', weight: 0, rebirth: state }, d);
  assert.ok(r.excluded.some(e => e.id === 'b' && e.reasons.some(r => r.includes('independent-slot'))));
});
test('browser HiGHS agrees with C++ CP-SAT on all current objectives', { skip: !process.env.KYARA_SOLVER }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'kyara-parity-'));
  try {
    writeFileSync(join(dir, 'data.json'), JSON.stringify(data)); writeFileSync(join(dir, 'state.json'), JSON.stringify(rebirth()));
    for (const o of [options(), options({ mode: 'free' }), options({ fee: .05, window: '30d' }),
      ...[0, .5, 1].map(weight => options({ goal: 'collection', weight, universes: ['Black Clover'] })),
      ...[0, .5, 1].map(weight => options({ goal: 'rebirth', weight, rebirth: rebirth() }))]) {
      const args = ['--dataset', join(dir, 'data.json'), '--purchase-mode', o.mode, '--profit-weight', String(o.weight), '--fee', String(o.fee), '--median-window', o.window, '--format', 'json'];
      if (o.goal === 'collection') args.push('--universe', 'Black Clover');
      if (o.goal === 'rebirth') args.push('--rebirth-state', join(dir, 'state.json'));
      const p = spawnSync(process.env.KYARA_SOLVER!, args, { encoding: 'utf8' }); assert.equal(p.status, 0, p.stderr);
      const cpp = JSON.parse(p.stdout), ts = solve(highs, data, o);
      assert.deepEqual(ts.ranking.map(c => [c.id, c.score]), cpp.ranking.map((c: any) => [c.id, c.score]));
      for (const c of ts.ranking) {
        const reference = cpp.ranking.find((r: any) => r.id === c.id);
        assert.ok(Math.abs(c.expected_profit! - reference.expected_profit) < 1e-9);
        if (o.weight < 1) assert.ok(Math.abs(c.progress - (o.goal === 'rebirth' ? reference.rebirth_progress : reference.expected_distinct_new_cards)) < 1e-12);
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
