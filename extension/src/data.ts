import { RARITIES, check, object, number, integer, identifier, timestamp,
  type Json, type Rarity, type Dataset, type Rebirth, type ProbabilityModel, type Booster } from './types';
import { moments, validateDataset, validateRebirth } from './model';

export function index(rows: unknown, label: string): Map<string, Json> {
  check(Array.isArray(rows) && rows.length > 0, `Missing ${label}`);
  const map = new Map<string, Json>();
  for (const row of rows) {
    object(row, label); const id = identifier(row.id);
    check(!map.has(id), `Duplicate ${label} ID ${id}`); map.set(id, row);
  }
  return map;
}
export function parsePrices(body: unknown, requested: string[]): Record<string, Json> {
  const ids = new Set(requested), result: Record<string, Json> = {};
  let rows: Json[];
  if (Array.isArray(body)) rows = body;
  else {
    object(body, 'Price response');
    rows = Array.isArray(body.items) ? body.items : Object.entries(body).map(([id, row]) => {
      object(row, 'Explicit median record'); return { id, ...row };
    });
  }
  for (const row of rows) {
    object(row, 'Price record'); const id = identifier(row.characterId ?? row.id);
    check(ids.has(id) && !Object.hasOwn(result, id), 'Unexpected or duplicate price ID');
    const value: Json = {};
    for (const field of ['median7d', 'median30d']) {
      check(Object.hasOwn(row, field), `Missing explicit ${field}`);
      value[field] = row[field] === null ? null : number(row[field], field);
    }
    for (const field of ['sales7d', 'sales30d']) if (Object.hasOwn(row, field)) value[field] = integer(row[field], field);
    result[id] = value;
  }
  return result;
}

export function verifyBaseline(raw: Json, bid: string) {
  const catalog = index(raw.catalog, 'catalogue'), packs = index(raw.packs, 'boosters'), pack = packs.get(bid)!;
  check(pack && !pack.rateUp && !pack.featuredPity, 'Featured mechanics require a separate model');
  const pool = raw.pack_pools?.[bid];
  check(Array.isArray(pool) && pool.length > 0, 'Missing complete card pool');
  const ids = pool.map(identifier);
  check(new Set(ids).size === ids.length && ids.every(id => catalog.has(id)), 'Duplicate or unknown pool cards');
  const rates = pack.rates;
  check(rates?.poolSize === ids.length, 'Incomplete published pool');
  const counts = Object.fromEntries(RARITIES.map(r => [r, ids.filter(id => catalog.get(id)!.rarity === r).length])) as Record<Rarity, number>;
  check(ids.every(id => RARITIES.includes(catalog.get(id)!.rarity)), 'Unknown pool rarity');
  const weights = raw.rules?.config?.dropWeights;
  for (const r of RARITIES) {
    check(counts[r] === rates.cardsByRarity?.[r], `Pool count mismatch for ${r}`);
    number(weights?.[r], `drop weight ${r}`);
  }
  check(Array.isArray(pack.slots) && pack.slots.length > 0 && Array.isArray(rates.slots)
    && pack.slots.length === rates.slots.length, 'Missing published slot definitions');
  let rounded = false;
  const distributions: Record<Rarity, number>[] = pack.slots.map((minimum: Rarity, i: number) => {
    const published = rates.slots[i], minIndex = RARITIES.indexOf(minimum);
    check(minIndex >= 0 && published.min === minimum, 'Slot minimum mismatch');
    const allowed = RARITIES.filter((r, j) => j >= minIndex && counts[r] > 0);
    const denominator = allowed.reduce((s, r) => s + weights[r], 0);
    check(denominator > 0, 'Empty slot distribution');
    const base = Object.fromEntries(RARITIES.map(r => [r, allowed.includes(r) ? weights[r] / denominator : 0])) as Record<Rarity, number>;
    const pct = Object.fromEntries(RARITIES.map(r => [r, number(published.pct?.[r], 'published slot percentage', 100)])) as Record<Rarity, number>;
    if (RARITIES.some(r => Math.abs(100 * base[r] - pct[r]) > 0.000050001)) {
      rounded = true; const total = RARITIES.reduce((s, r) => s + pct[r], 0);
      check(Math.abs(total - 100) <= 0.000310001 && RARITIES.every(r => pct[r] === 0 || allowed.includes(r)), 'Invalid published slot rates');
      return Object.fromEntries(RARITIES.map(r => [r, pct[r] / total])) as Record<Rarity, number>;
    }
    return base;
  });
  const model: ProbabilityModel = { type: 'independent_slots', slots: [] };
  for (const distribution of distributions) {
    const probabilities = Object.fromEntries(ids.filter(id => distribution[catalog.get(id)!.rarity as Rarity] > 0)
      .map(id => [id, distribution[catalog.get(id)!.rarity as Rarity] / counts[catalog.get(id)!.rarity as Rarity]]));
    const matching = model.slots!.find(s => JSON.stringify(s.probabilities) === JSON.stringify(probabilities));
    if (matching) matching.draws++; else model.slots!.push({ draws: 1, probabilities });
  }
  const outcomes = moments(model, catalog), checked = new Set<Rarity>(); let samples = 0;
  for (const outcome of outcomes) {
    const detail = raw.characters?.[outcome.card_id]; if (!detail) continue;
    const r = catalog.get(outcome.card_id)!.rarity as Rarity;
    check(identifier(detail.id) === outcome.card_id && detail.rarity === r, 'Captured card detail mismatch');
    const observed = number(detail.dropChance?.[bid], 'published card odds', 1);
    const tolerance = rounded ? 4e-6 * distributions.length / counts[r] : 1e-12;
    check(Math.abs(observed - outcome.occurrence_probability) <= tolerance, `Published card odds disagree for ${outcome.card_id}`);
    checked.add(r); samples++;
  }
  const active = new Set(outcomes.map(o => catalog.get(o.card_id)!.rarity));
  check([...active].every(r => checked.has(r)), 'Missing probability sample for an active rarity');
  for (const r of RARITIES) {
    const pub = rates.perBooster?.[r], ps = distributions.map(d => d[r]);
    const error = rounded ? 4e-6 * distributions.length : 0;
    const expected = ps.reduce((s, p) => s + p, 0), occurrence = 1 - ps.reduce((s, p) => s * (1 - p), 1);
    const perCard = counts[r] ? 1 - ps.reduce((s, p) => s * (1 - p / counts[r]), 1) : 0;
    check(Math.abs(number(pub?.expected, 'published expectation') - expected) <= 0.000050001 + error, 'Rarity expectation mismatch');
    check(Math.abs(number(pub?.atLeastOnePct, 'published occurrence', 100) - occurrence * 100) <= 0.000050001 + 100 * error, 'Rarity occurrence mismatch');
    check(Math.abs(number(pub?.perCardPct, 'published per-card odds', 100) - perCard * 100) <= 0.000050001 + (counts[r] ? 100 * error / counts[r] : 0), 'Per-card odds mismatch');
  }
  return { model, pool_complete: true, verified_at: raw.collected_at,
    evidence: 'Complete pool and published rates checked against representative details; independent replacement draws, uniform within rarity.',
    validation: { level: 'published_rates_with_rarity_samples', checked_cards: samples, pool_cards: ids.length,
      probability_precision: rounded ? 'rounded_published_slot_rates' : 'base_weights' },
    opening_context: { type: 'normal_baseline', description: 'Normal-opening baseline; golden, pity and god-pack effects excluded.' } };
}

export async function normalizeRaw(raw: Json): Promise<Dataset> {
  const collected = timestamp(raw.collected_at), cards = index(raw.catalog, 'catalogue'), packs = index(raw.packs, 'boosters');
  const boosters: Booster[] = [...packs].map(([id, p]) => {
    const issues: string[] = []; let verification, outcomes: Booster['outcomes'] = [];
    try { verification = verifyBaseline(raw, id); outcomes = moments(verification.model, cards); }
    catch (e) { issues.push(`Unverified probability model: ${(e as Error).message}`); }
    const cost = p.chakraPrice ?? null; if (cost !== null) number(cost, 'booster cost');
    const start = p.schedule?.start, end = p.schedule?.end;
    const available = !p.grantOnly && (!start || Date.parse(timestamp(start)) <= Date.parse(collected))
      && (!end || Date.parse(timestamp(end)) > Date.parse(collected));
    return { id, name: p.name ?? id, cost, available, uses_free_packs: !!p.usesFreePacks,
      issues, outcomes, verification };
  });
  const bytes = new TextEncoder().encode(JSON.stringify(raw));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return validateDataset({ schema_version: 1, collected_at: collected, metadata_collected_at: raw.metadata_collected_at ?? collected,
    snapshot_id: [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join(''),
    synthetic: !!raw.synthetic, boosters,
    cards: [...cards].map(([id, c]) => ({ id, name: c.name, universe: c.series, rarity: c.rarity,
      median7d: raw.prices?.[id]?.median7d ?? null, median30d: raw.prices?.[id]?.median30d ?? null })) });
}

export function normalizeRebirth(status: Json, inventory: unknown, dataset: Dataset): Rebirth {
  const cards = new Map(dataset.cards.map(c => [c.id, c]));
  const items = Array.isArray(inventory) ? inventory : (inventory as Json)?.items;
  check(Array.isArray(items) && Array.isArray(status.requirements), 'Invalid account response');
  const seen = new Set<string>(), owned: string[] = [];
  for (const row of items) {
    object(row, 'Inventory item'); const id = identifier(row.characterId ?? row.id);
    check(cards.has(id) && !seen.has(id), 'Unknown or duplicate inventory card; refresh catalogue'); seen.add(id);
    if (integer(row.qty, 'quantity') > 0) owned.push(id);
  }
  const mapping: Record<string, Rarity> = { C: 'C', U: 'U', R: 'R', E: 'E', legendaries: 'L', mythics: 'M' };
  const requirements: Json = {};
  for (const row of status.requirements) {
    const r = mapping[row.key]; if (!r) continue;
    check(!Object.hasOwn(requirements, r), 'Duplicate rarity requirement'); requirements[r] = { current: row.have, target: row.need };
  }
  return validateRebirth({ schema_version: 1, counting: 'unique', next_rebirth: status.next,
    collected_at: new Date().toISOString(), owned: owned.sort(), requirements }, cards);
}
