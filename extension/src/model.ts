import type { Highs } from 'highs';
import { RARITIES, check, object, number, integer, identifier, timestamp, compareIds,
  type Dataset, type Rebirth, type Options, type Result, type Candidate, type Booster, type Card, type Outcome, type ProbabilityModel } from './types';

export function moments(model: ProbabilityModel, cards: Map<string, unknown>): Outcome[] {
  object(model, 'Probability model');
  if (model.type === 'moments') {
    object(model.cards, 'Card moments');
    const rows = Object.entries(model.cards).map(([card_id, m]) => {
      check(cards.has(card_id), `Unknown model card ${card_id}`);
      const expected_copies = number(m.expected_copies, 'expected copies');
      const occurrence_probability = number(m.occurrence_probability, 'occurrence probability', 1);
      check(expected_copies + 1e-12 >= occurrence_probability && (expected_copies > 0) === (occurrence_probability > 0), 'Inconsistent card moments');
      return { card_id, expected_copies, occurrence_probability };
    });
    check(rows.length > 0, 'Empty moments model'); return rows;
  }
  check(model.type === 'independent_slots' && Array.isArray(model.slots) && model.slots.length > 0, 'Missing independent-slot model');
  const values = new Map<string, { expected: number; absent: number }>();
  let totalDraws = 0;
  for (const slot of model.slots) {
    const draws = integer(slot.draws, 'slot draws', 10000);
    check(draws > 0 && (totalDraws += draws) <= 100000, 'Excessive slot draws');
    object(slot.probabilities, 'Slot distribution');
    let sum = 0;
    for (const [id, p] of Object.entries(slot.probabilities)) {
      check(cards.has(id), `Unknown model card ${id}`); sum += number(p, 'slot probability', 1);
      const v = values.get(id) ?? { expected: 0, absent: 1 };
      v.expected += draws * p; v.absent *= (1 - p) ** draws; values.set(id, v);
    }
    check(Math.abs(sum - 1) < 1e-9, 'Slot probabilities must sum to one');
  }
  return [...values].sort(([a], [b]) => compareIds(a, b)).filter(([, v]) => v.expected > 0)
    .map(([card_id, v]) => ({ card_id, expected_copies: v.expected, occurrence_probability: 1 - v.absent }));
}

export function validateDataset(input: unknown): Dataset {
  object(input, 'Dataset');
  check(input.schema_version === 1 && typeof input.snapshot_id === 'string', 'Unsupported dataset');
  timestamp(input.collected_at);
  check(Array.isArray(input.cards) && input.cards.length > 0 && Array.isArray(input.boosters), 'Missing cards/boosters');
  const cards = new Map<string, Card>();
  for (const card of input.cards) {
    object(card, 'Card'); const id = identifier(card.id);
    check(!cards.has(id) && typeof card.name === 'string' && typeof card.universe === 'string' && RARITIES.includes(card.rarity), 'Invalid or duplicate card');
    for (const key of ['median7d', 'median30d']) if (card[key] !== null) number(card[key], key);
    cards.set(id, { ...card, id } as Card);
  }
  const ids = new Set<string>();
  const boosters: Booster[] = input.boosters.map((b: Booster) => {
    object(b, 'Booster'); const id = identifier(b.id);
    check(!ids.has(id) && typeof b.name === 'string' && typeof b.available === 'boolean'
      && typeof b.uses_free_packs === 'boolean' && Array.isArray(b.issues) && b.issues.every(x => typeof x === 'string') && Array.isArray(b.outcomes), 'Invalid or duplicate booster');
    ids.add(id); if (b.cost !== null) number(b.cost, 'booster cost');
    const seen = new Set<string>();
    const outcomes = b.outcomes.map(o => {
      const cid = identifier(o.card_id); check(cards.has(cid) && !seen.has(cid), 'Unknown or duplicate outcome'); seen.add(cid);
      const e = number(o.expected_copies, 'expected copies'), p = number(o.occurrence_probability, 'occurrence probability', 1);
      check(e + 1e-12 >= p && (e > 0) === (p > 0), 'Inconsistent outcome'); return { ...o, card_id: cid };
    });
    if (outcomes.length && b.verification?.model) {
      const computed = moments(b.verification.model, cards);
      const byId = new Map(computed.map(o => [o.card_id, o]));
      check(computed.length === outcomes.length && outcomes.every(o => {
        const m = byId.get(o.card_id); return m && Math.abs(m.expected_copies - o.expected_copies) < 1e-9
          && Math.abs(m.occurrence_probability - o.occurrence_probability) < 1e-9;
      }), 'Stored outcomes disagree with probability model');
    }
    return { ...b, id, outcomes };
  });
  return { ...input, cards: [...cards.values()], boosters } as Dataset;
}

export function validateRebirth(input: unknown, cards: Map<string, Card>): Rebirth {
  object(input, 'Rebirth state');
  check(input.schema_version === 1 && input.counting === 'unique', 'Unsupported rebirth state');
  timestamp(input.collected_at); check(integer(input.next_rebirth, 'next rebirth') > 0, 'Missing next rebirth');
  object(input.requirements, 'Rarity requirements');
  check(Object.keys(input.requirements).length === 6 && Array.isArray(input.owned), 'Missing rebirth requirements/holdings');
  const owned = input.owned.map(identifier) as string[];
  check(new Set(owned).size === owned.length && owned.every(id => cards.has(id)), 'Unknown or duplicate owned card; refresh catalogue and state');
  for (const r of RARITIES) {
    object(input.requirements[r], `Requirement ${r}`);
    integer(input.requirements[r].target, `${r} target`);
    const current = integer(input.requirements[r].current, `${r} current`);
    check(owned.filter(id => cards.get(id)!.rarity === r).length === current, `Holdings disagree with ${r} count; sync again`);
  }
  return { ...input, owned } as Rebirth;
}

export function rebirthProgress(b: Booster, cards: Map<string, Card>, state: Rebirth) {
  const owned = new Set(state.owned), byRarity: Record<string, unknown> = {};
  let score = 0, unfinished = 0;
  for (const r of RARITIES) {
    const d = Math.max(0, state.requirements[r].target - state.requirements[r].current);
    if (d > 0) unfinished++;
    const missing = b.outcomes.filter(o => cards.get(o.card_id)!.rarity === r && !owned.has(o.card_id) && o.occurrence_probability > 0);
    const expected = missing.reduce((s, o) => s + o.occurrence_probability, 0);
    let credited = d === 0 ? 0 : expected;
    if (d > 0 && d < missing.length) {
      const model = b.verification?.model;
      check(model?.type === 'independent_slots' && model.slots?.length, 'Capped rebirth requires independent-slot model');
      const draws = model.slots.reduce((s, slot) => s + slot.draws, 0);
      if (d < draws) {
        check(d * draws <= 10000000, 'Rebirth cap exceeds exact evaluation limit');
        let distribution = new Float64Array(d + 1); distribution[0] = 1;
        for (const slot of model.slots) {
          const ps = missing.map(o => slot.probabilities[o.card_id] ?? 0);
          check(d === 1 || ps.every(p => Math.abs(p - ps[0]) < 1e-12), 'Capped rebirth needs uniform missing-card probabilities');
          const q = Math.min(1, ps.reduce((s, p) => s + p, 0));
          for (let draw = 0; draw < slot.draws; draw++) {
            const next = new Float64Array(d + 1); next[d] = distribution[d];
            for (let k = 0; k < d; k++) {
              const p = q * (1 - k / missing.length);
              next[k] += distribution[k] * (1 - p); next[k + 1] += distribution[k] * p;
            }
            distribution = next;
          }
        }
        credited = distribution.reduce((s, p, k) => s + p * k, 0);
      }
    }
    const fraction = d > 0 ? credited / d : 0;
    byRarity[r] = { expected_distinct_new_cards: expected, expected_credited_cards: credited, expected_fraction_of_remaining_gap: fraction };
    score += fraction;
  }
  return { score: unfinished ? score / unfinished : 0, byRarity };
}

export function formulate(dataset: Dataset, options: Options): Result {
  number(options.weight, 'profit weight', 1); number(options.fee, 'selling fee', 1);
  check(['free', 'paid'].includes(options.mode) && ['7d', '30d'].includes(options.window)
    && ['profit', 'collection', 'rebirth'].includes(options.goal), 'Invalid solver options');
  check(options.goal !== 'profit' || options.weight === 1, 'Profit mode requires weight 1');
  const cards = new Map(dataset.cards.map(c => [c.id, c]));
  const state = options.goal === 'rebirth' ? validateRebirth(options.rebirth, cards) : undefined;
  const owned = new Set(state?.owned ?? options.owned.map(identifier));
  check([...owned].every(id => cards.has(id)), 'Owned cards absent from dataset; refresh data');
  const selected = new Set(options.universes), names = new Set(dataset.cards.map(c => c.universe));
  check(options.goal !== 'collection' || selected.size > 0, 'Choose at least one universe');
  check([...selected].every(n => names.has(n)), 'Unknown selected universe');
  const result: Result = { status: 'NO_ELIGIBLE_BOOSTER', solver: 'HiGHS (WebAssembly)', snapshot_id: dataset.snapshot_id,
    collected_at: dataset.collected_at, ranking: [], best: null, excluded: [], warnings: [
      'Normal-opening baseline; golden, pity and god-pack effects are excluded.',
      'Historical medians estimate resale value; sales are not guaranteed.'
    ], recommend_paid_purchase: null, model: '' };
  if (dataset.synthetic) result.warnings.push('Synthetic fixture: not live Kyara data.');
  if (Date.now() - Date.parse(dataset.collected_at) > 86400000) result.warnings.push('Snapshot is older than 24 hours; refresh prices and availability.');
  if (options.fee === 0) result.warnings.push('Selling fee is assumed to be zero.');
  if (state) {
    result.warnings.push('Only unique-card rarity requirements are scored; other rebirth conditions are ignored.');
    if (RARITIES.every(r => state.requirements[r].current >= state.requirements[r].target)) {
      result.warnings.push('All rarity targets are met; this does not establish full rebirth eligibility.');
      if (options.weight === 0) { result.status = 'REBIRTH_RARITY_TARGETS_MET'; return result; }
    }
  }
  for (const b of [...dataset.boosters].sort((a, b) => compareIds(a.id, b.id))) {
    const reasons = [...b.issues];
    if (!b.available) reasons.push('Unavailable at snapshot time');
    if (b.cost === null) reasons.push('Missing booster cost');
    if (options.mode === 'paid' && b.cost === 0) reasons.push('Not a paid booster');
    if (options.mode === 'free' && b.cost !== 0 && !b.uses_free_packs) reasons.push('Does not accept free packs');
    if (!b.outcomes.length) reasons.push('Missing card outcomes');
    const cost = options.mode === 'free' ? 0 : b.cost ?? 0;
    let proceeds = 0, progress = 0, known = 0;
    for (const o of b.outcomes) {
      const card = cards.get(o.card_id)!;
      if (options.goal === 'collection' && selected.has(card.universe) && !owned.has(card.id)) progress += o.occurrence_probability;
      const price = card[`median${options.window}`];
      if (price === null) { if (options.weight > 0) reasons.push(`Missing ${options.window} median for card ${card.id}`); }
      else { known++; proceeds += o.expected_copies * price * (1 - options.fee); }
    }
    let byRarity;
    if (state && options.weight < 1 && !reasons.length) {
      try { const p = rebirthProgress(b, cards, state); progress = p.score; byRarity = p.byRarity; }
      catch (e) { reasons.push(`Rebirth progress: ${(e as Error).message}`); }
    }
    check(Number.isFinite(proceeds) && Number.isFinite(progress), 'Objective overflow');
    if (reasons.length) result.excluded.push({ id: b.id, reasons });
    else result.ranking.push({ id: b.id, name: b.name, cost,
      expected_profit: known === b.outcomes.length ? proceeds - cost : null, progress,
      normalized_profit: 0, normalized_progress: 0, score: 0,
      price_coverage: { known, total: b.outcomes.length }, rebirth_by_rarity: byRarity });
  }
  const candidates = result.ranking, n = candidates.length;
  if (!n) return result;
  check(n <= 1000000, 'Too many boosters');
  const profits = candidates.flatMap(c => c.expected_profit === null ? [] : [c.expected_profit]);
  const pmin = Math.min(...profits), pmax = Math.max(...profits);
  const umin = Math.min(...candidates.map(c => c.progress)), umax = Math.max(...candidates.map(c => c.progress));
  candidates.forEach(c => {
    c.normalized_profit = options.weight > 0 && pmax > pmin ? (c.expected_profit! - pmin) / (pmax - pmin) : 0;
    c.normalized_progress = options.weight < 1 && umax > umin ? (c.progress - umin) / (umax - umin) : 0;
    c.score = Math.round(1000000 * (options.weight * c.normalized_profit + (1 - options.weight) * c.normalized_progress));
    check(Number.isSafeInteger(c.score) && c.score >= 0 && c.score <= 1000000, 'Invalid objective score');
  });
  // Preserve the CLI's lexicographic tie-break using integer coefficients.
  const terms = candidates.map((c, i) => `${c.score * (n + 1) + n - i} x${i}`);
  result.model = `Maximize\n score: ${terms.join(' + ')}\nSubject To\n choose_one: ${candidates.map((_, i) => `x${i}`).join(' + ')} = 1\nBinary\n ${candidates.map((_, i) => `x${i}`).join(' ')}\nEnd\n`;
  if (options.mode === 'paid') {
    result.recommend_paid_purchase = !(options.weight === 1 && pmax < 0);
    if (!result.recommend_paid_purchase) result.warnings.push('All evaluated paid boosters lose money in expectation; no purchase recommended.');
  }
  return result;
}

export function solve(highs: Highs, dataset: Dataset, options: Options): Result {
  const result = formulate(validateDataset(dataset), options);
  if (!result.model) return result;
  const solution = highs.solve(result.model, { output_flag: false, mip_rel_gap: 0, mip_abs_gap: 0, random_seed: 0, threads: 1 });
  check(solution.Status === 'Optimal', `HiGHS did not prove optimality: ${solution.Status}`);
  const chosen = result.ranking.filter((_, i) => solution.Columns[`x${i}`]?.Primal > 0.5);
  check(chosen.length === 1, 'HiGHS returned an invalid choice');
  result.ranking.sort((a, b) => b.score - a.score || compareIds(a.id, b.id));
  check(chosen[0].id === result.ranking[0].id, 'HiGHS result disagrees with score ranking');
  result.best = chosen[0]; result.status = 'OPTIMAL'; return result;
}
