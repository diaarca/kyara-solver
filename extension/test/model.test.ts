import { test } from 'node:test';
import assert from 'node:assert/strict';
import loadHighs from 'highs';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { solve, validateDataset, validateRebirth, moments } from '../src/model';
import { type Dataset, type Options, RARITIES } from '../src/types';
import { fixture, options, rebirth, pityFixture } from './helpers';
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
    for (const base of [options(), options({ mode: 'free' }), options({ fee: .05, window: '30d' }),
      ...[0, .5, 1].map(weight => options({ goal: 'collection', weight, universes: ['Black Clover'] })),
      ...[0, .5, 1].map(weight => options({ goal: 'rebirth', weight, rebirth: rebirth() }))]) for (const horizon of [1, 2, 100]) {
      const o = { ...base, horizon };
      const args = ['--horizon', String(o.horizon), '--dataset', join(dir, 'data.json'), '--purchase-mode', o.mode, '--profit-weight', String(o.weight), '--fee', String(o.fee), '--median-window', o.window, '--format', 'json'];
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

test('horizon totals scale profit and preserve per-opening cost', () => {
  const one = run({ horizon: 1 }), many = run({ horizon: 100 });
  assert.equal(many.horizon, 100); assert.equal(many.best!.id, one.best!.id);
  assert.equal(many.best!.expected_profit, 9000); assert.equal(many.best!.cost, 20); assert.equal(many.best!.total_cost, 2000);
  assert.deepEqual(one.ranking.map(c => [c.id, c.score]), run().ranking.map(c => [c.id, c.score]));
});
test('horizon duplicates saturate and can change the completion winner', () => {
  const d = structuredClone(data);
  d.cards = [1, 2, 3].map(id => ({ id: String(id), name: String(id), universe: 'Test', rarity: 'R', median7d: 1, median30d: 1 }));
  d.boosters = [
    { id: 'a', name: 'One card', cost: 1, available: true, uses_free_packs: true, issues: [], verification: { model: { type: 'independent_slots', slots: [{ draws: 1, probabilities: { '1': 1 } }] } }, outcomes: [{ card_id: '1', expected_copies: 1, occurrence_probability: 1 }] },
    { id: 'b', name: 'Three cards', cost: 1, available: true, uses_free_packs: true, issues: [], verification: { model: { type: 'independent_slots', slots: [{ draws: 1, probabilities: { '1': 1/3, '2': 1/3, '3': 1/3 } }] } }, outcomes: d.cards.map(c => ({ card_id: c.id, expected_copies: 1/3, occurrence_probability: 1/3 })) }
  ];
  const o = { goal: 'collection' as const, weight: 0, universes: ['Test'] };
  assert.equal(run({ ...o, horizon: 1 }, d).best!.id, 'a');
  const two = run({ ...o, horizon: 2 }, d); assert.equal(two.best!.id, 'b'); assert.ok(Math.abs(two.best!.progress - 5/3) < 1e-12);
  assert.equal(run({ ...o, horizon: 10000 }, d).best!.progress, 3);
});
test('rebirth caps apply across openings, including exact cap two', () => {
  const state = rebirth();
  const r = run({ goal: 'rebirth', weight: 0, rebirth: state, horizon: 2 });
  assert.equal(r.ranking.find(b => b.id === 'a')!.progress, .46875);
  const d = structuredClone(data);
  d.cards = [1, 2, 3].map(id => ({ id: String(id), name: String(id), universe: 'Test', rarity: 'R', median7d: 1, median30d: 1 }));
  d.boosters = [{ id: 'cap', name: 'Cap', cost: 1, available: true, uses_free_packs: true, issues: [],
    verification: { model: { type: 'independent_slots', slots: [{ draws: 3, probabilities: { '1': 1/3, '2': 1/3, '3': 1/3 } }] } },
    outcomes: d.cards.map(c => ({ card_id: c.id, expected_copies: 1, occurrence_probability: 19/27 })) }];
  state.owned = []; for (const r of RARITIES) state.requirements[r] = { current: 0, target: r === 'R' ? 2 : 0 };
  assert.ok(Math.abs(run({ goal: 'rebirth', weight: 0, rebirth: state, horizon: 2 }, d).best!.progress - (1 - 1/486)) < 1e-12);
});
test('invalid horizons and expensive capped evaluations are rejected', () => {
  for (const horizon of [0, -1, .5, 10001, NaN, Infinity]) assert.throws(() => run({ horizon }));
  const d = structuredClone(data);
  d.cards = Array.from({ length: 20 }, (_, i) => ({ id: String(i), name: String(i), universe: 'Test', rarity: 'R', median7d: 1, median30d: 1 }));
  d.boosters = [{ id: 'large', name: 'Large', cost: 1, available: true, uses_free_packs: true, issues: [],
    verification: { model: { type: 'independent_slots', slots: [{ draws: 100, probabilities: Object.fromEntries(d.cards.map(c => [c.id, .05])) }] } },
    outcomes: d.cards.map(c => ({ card_id: c.id, expected_copies: 5, occurrence_probability: 1 - .95**100 })) }];
  const state = rebirth(); state.owned = []; for (const r of RARITIES) state.requirements[r] = { current: 0, target: r === 'R' ? 11 : 0 };
  assert.equal(run({ goal: 'rebirth', weight: 0, rebirth: state, horizon: 10000 }, d).status, 'NO_ELIGIBLE_BOOSTER');
});

test('the Mythic toggle replaces one draw in the entire batch and preserves natural drops and costs', () => {
  const d = pityFixture();
  const normal = run({ horizon: 2 }, d), guaranteed = run({ horizon: 2, guaranteed_mythic: true }, d);
  assert.equal(normal.guaranteed_mythic, false);
  assert.deepEqual(normal.ranking, run({ horizon: 2, guaranteed_mythic: false }, d).ranking);
  assert.equal(guaranteed.guaranteed_mythic, true);
  assert.equal(guaranteed.best!.cost, 20); assert.equal(guaranteed.best!.total_cost, 40);
  assert.ok(Math.abs(normal.best!.expected_profit! - 380) < 1e-10);
  // Three normal draws plus one uniform Mythic, not an extra card or one guarantee per opening.
  assert.ok(Math.abs(guaranteed.best!.expected_profit! - 475) < 1e-10);
  assert.ok(Math.abs(run({ horizon: 2, guaranteed_mythic: true, fee: .1 }, d).best!.expected_profit! - 423.5) < 1e-10);
  assert.ok(Math.abs(run({ horizon: 2, guaranteed_mythic: true, mode: 'free' }, d).best!.expected_profit! - 515) < 1e-10);
  assert.ok(Math.abs(run({ horizon: 2, guaranteed_mythic: true, window: '30d' }, d).best!.expected_profit! - 422) < 1e-10);
  assert.ok(Math.abs(run({ horizon: 10000, guaranteed_mythic: true }, d).best!.expected_profit! - (190 * 10000 + 95)) < 1e-7);
});

test('the guarantee uses the first slot group and can change which booster is best', () => {
  const d = pityFixture(), cards = new Map(d.cards.map(c => [c.id, c]));
  const original = d.boosters[0];
  const slots = [original.verification!.model.slots![0], { draws: 1, probabilities: { '1': 1 } }];
  slots[0] = { ...slots[0], draws: 1 };
  original.verification!.model.slots = slots;
  original.outcomes = moments(original.verification!.model, cards);
  assert.ok(Math.abs(run({ guaranteed_mythic: true }, d).best!.expected_profit! - 190) < 1e-10);
  d.boosters = [
    { ...original, id: 'rare-expensive', verification: { model: { type: 'independent_slots', slots: [{ draws: 1, probabilities: { '1': .99, '4': .01 } }] } } },
    { ...original, id: 'common-cheap', verification: { model: { type: 'independent_slots', slots: [{ draws: 1, probabilities: { '1': .01, '2': .99 } }] } } },
  ];
  for (const b of d.boosters) b.outcomes = moments(b.verification!.model, cards);
  assert.equal(run({}, d).best!.id, 'common-cheap');
  assert.equal(run({ guaranteed_mythic: true }, d).best!.id, 'rare-expensive');
});

test('guaranteed batch collection and rebirth caps agree with exhaustive draw enumeration', () => {
  const d = pityFixture(), probabilities = d.boosters[0].verification!.model.slots![0].probabilities;
  const state = rebirth(); state.owned = [];
  for (const r of RARITIES) state.requirements[r] = { current: 0, target: r === 'M' ? 2 : 0 };
  const o = { horizon: 2, guaranteed_mythic: true };
  let profit = 0, distinct = 0, credited = 0, mythics = 0;
  function enumerate(draw: number, picked: string[], probability: number) {
    if (draw === 4) {
      const unique = new Set(picked), m = [...unique].filter(id => id !== '1').length;
      profit += probability * (picked.reduce((sum, id) => sum + d.cards.find(c => c.id === id)!.median7d!, 0) - 40);
      distinct += probability * unique.size;
      credited += probability * Math.min(2, m) / 2;
      mythics += probability * picked.filter(id => id !== '1').length;
      return;
    }
    const ps = draw === 3 ? { '2': 1/3, '3': 1/3, '4': 1/3 } : probabilities;
    for (const [id, p] of Object.entries(ps)) enumerate(draw + 1, [...picked, id], probability * p);
  }
  enumerate(0, [], 1);
  assert.ok(Math.abs(run(o, d).best!.expected_profit! - profit) < 1e-10);
  assert.ok(Math.abs(mythics - 2.5) < 1e-12);
  const collection = run({ ...o, goal: 'collection', weight: 0, universes: ['Test'] }, d);
  assert.ok(Math.abs(collection.best!.progress - distinct) < 1e-12);
  const capped = run({ ...o, goal: 'rebirth', weight: 0, rebirth: state }, d);
  assert.ok(Math.abs(capped.best!.progress - credited) < 1e-12);
  state.requirements.M.target = 1;
  assert.equal(run({ ...o, goal: 'rebirth', weight: 0, rebirth: state }, d).best!.progress, 1);
  state.owned = ['2']; state.requirements.M = { current: 1, target: 2 };
  assert.ok(run({ ...o, goal: 'rebirth', weight: 0, rebirth: state }, d).best!.progress < 1);
});

test('pity excludes unsupported pools/models and prices only cards that can still occur', () => {
  const r = run({ guaranteed_mythic: true });
  assert.deepEqual(r.ranking.map(c => c.id), ['a']);
  assert.ok(r.excluded.some(e => e.id === 'b' && e.reasons.some(reason => reason.includes('No Mythic'))));
  const d = pityFixture();
  d.boosters[0].verification!.model = { type: 'moments', cards: Object.fromEntries(d.boosters[0].outcomes.map(o => [o.card_id, o])) };
  assert.equal(run({ guaranteed_mythic: true }, d).status, 'NO_ELIGIBLE_BOOSTER');
  assert.equal(run({}, d).status, 'OPTIMAL');
  const single = pityFixture();
  single.boosters[0].verification!.model.slots![0].draws = 1;
  single.boosters[0].outcomes = single.cards.map(c => ({ card_id: c.id, expected_copies: c.id === '1' ? .5 : 1/6, occurrence_probability: c.id === '1' ? .5 : 1/6 }));
  single.cards[0].median7d = null;
  const forced = run({ guaranteed_mythic: true }, single);
  assert.equal(forced.status, 'OPTIMAL'); assert.equal(forced.best!.price_coverage.total, 3);
  assert.equal(run({ guaranteed_mythic: true, horizon: 2 }, single).status, 'NO_ELIGIBLE_BOOSTER');
  assert.throws(() => run({ guaranteed_mythic: 'yes' as unknown as boolean }));
});

test('CLI and browser agree on guaranteed batch profit, collection and capped rebirth', { skip: !process.env.KYARA_SOLVER }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'kyara-pity-parity-'));
  try {
    const d = pityFixture(), state = rebirth(); state.owned = [];
    for (const r of RARITIES) state.requirements[r] = { current: 0, target: r === 'M' ? 2 : 0 };
    writeFileSync(join(dir, 'data.json'), JSON.stringify(d)); writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
    for (const horizon of [1, 2, 10000]) for (const mode of ['paid', 'free'] as const) for (const goal of ['profit', 'collection', 'rebirth'] as const) {
      const o = options({ horizon, mode, goal, guaranteed_mythic: true, weight: goal === 'profit' ? 1 : .5, universes: goal === 'collection' ? ['Test'] : [], rebirth: state });
      const args = ['--dataset', join(dir, 'data.json'), '--format', 'json', '--horizon', String(horizon), '--guaranteed-mythic', '--profit-weight', String(o.weight), '--purchase-mode', mode];
      if (goal === 'collection') args.push('--universe', 'Test');
      if (goal === 'rebirth') args.push('--rebirth-state', join(dir, 'state.json'));
      const p = spawnSync(process.env.KYARA_SOLVER!, args, { encoding: 'utf8' }); assert.equal(p.status, 0, p.stderr);
      const cpp = JSON.parse(p.stdout), browser = run(o, d);
      assert.equal(cpp.guaranteed_mythic, true);
      assert.ok(Math.abs(cpp.best.expected_profit - browser.best!.expected_profit!) < 1e-7);
      assert.ok(Math.abs((goal === 'rebirth' ? cpp.best.rebirth_progress : cpp.best.expected_distinct_new_cards) - browser.best!.progress) < 1e-10);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
