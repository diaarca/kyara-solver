import { check, object, identifier, integer, number, timestamp, compareIds } from './types';
import { index, parsePrices } from './data';

export interface SeriesCard {
  id: string; name: string; universe: string; median7d: number | null; median30d: number | null;
}
export interface SeriesState {
  schema_version: 1; collected_at: string; synthetic?: boolean;
  cards: SeriesCard[]; owned: string[]; completed_series: string[]; remaining_series: string[];
}
export interface SeriesRow {
  universe: string; total_cards: number; owned_cards: number; total_cost: number;
  missing_cards: { id: string; name: string; price: number }[];
}
export interface SeriesResult {
  status: 'OPTIMAL' | 'SERIES_READY' | 'NO_ELIGIBLE_SERIES'; solver: string;
  collected_at: string; window: string; ranking: SeriesRow[]; best: SeriesRow | null;
  excluded: { universe: string; reasons: string[] }[]; warnings: string[]; model?: string;
}

function names(value: unknown, label: string): string[] {
  check(Array.isArray(value), `Missing ${label}`);
  check(value.every(n => typeof n === 'string' && n.trim().length > 0), `Invalid ${label}`);
  check(new Set(value).size === value.length, `Duplicate ${label}`);
  return [...value].sort(compareIds);
}

export function remainingSeries(cards: SeriesCard[], completed: string[]): string[] {
  const counts = new Map<string, number>(), done = new Set(completed);
  for (const card of cards) counts.set(card.universe, (counts.get(card.universe) ?? 0) + 1);
  return [...counts].filter(([name, count]) => count >= 5 && !done.has(name)).map(([name]) => name).sort(compareIds);
}

export function validateSeries(value: unknown): SeriesState {
  object(value, 'Series snapshot');
  check(value.schema_version === 1, 'Unsupported series schema');
  timestamp(value.collected_at);
  check(Array.isArray(value.cards), 'Missing series cards');
  const ids = new Set<string>();
  const cards = value.cards.map((card: unknown): SeriesCard => {
    object(card, 'Series card'); const id = identifier(card.id);
    check(!ids.has(id), 'Duplicate series card ID'); ids.add(id);
    check(typeof card.name === 'string' && typeof card.universe === 'string' && card.universe.trim().length > 0, 'Invalid series card name/universe');
    for (const field of ['median7d', 'median30d']) if (card[field] !== null) number(card[field], field);
    return { id, name: card.name, universe: card.universe, median7d: card.median7d, median30d: card.median30d };
  });
  check(Array.isArray(value.owned), 'Missing series holdings');
  const owned = value.owned.map(identifier);
  check(new Set(owned).size === owned.length && owned.every((id: string) => ids.has(id)), 'Unknown or duplicate owned card');
  const completed = names(value.completed_series, 'completed series');
  const remaining = names(value.remaining_series, 'remaining series');
  check(JSON.stringify(remaining) === JSON.stringify(remainingSeries(cards, completed)), 'Remaining series do not match catalogue and missions');
  return { schema_version: 1, collected_at: value.collected_at, synthetic: !!value.synthetic,
    cards, owned: owned.sort(compareIds), completed_series: completed, remaining_series: remaining };
}

export async function collectSeries(client: { get(path: string): Promise<any> }, progress: (message: string) => void = () => {}): Promise<SeriesState> {
  const catalog = index(await client.get('/characters'), 'catalogue');
  const missions = await client.get('/me/progress');
  object(missions, 'Missions response');
  check(Array.isArray(missions.series), 'Missing completed series in missions');
  const completed = names(missions.series.map((row: unknown) => {
    object(row, 'Completed series'); timestamp(row.completedAt);
    check(integer(row.size, 'completed series size') >= 5 && typeof row.claimed === 'boolean', 'Invalid completed series');
    return row.series;
  }), 'completed series');
  const inventory = await client.get('/me/collection?lean=1');
  const items = Array.isArray(inventory) ? inventory : inventory?.items;
  check(Array.isArray(items), 'Invalid collection response');
  const seen = new Set<string>(), owned: string[] = [];
  for (const row of items) {
    object(row, 'Inventory card'); const id = identifier(row.characterId ?? row.id);
    check(catalog.has(id) && !seen.has(id), 'Unknown or duplicate inventory card; refresh catalogue'); seen.add(id);
    if (integer(row.qty, 'quantity') > 0) owned.push(id);
  }
  const cards: SeriesCard[] = [...catalog].map(([id, c]) => ({ id, name: c.name, universe: c.series, median7d: null, median30d: null }));
  // Validate identity before grouping, including snapshots with no remaining series.
  for (const c of cards) check(typeof c.name === 'string' && typeof c.universe === 'string' && c.universe.trim().length > 0, 'Invalid catalogue card');
  const remaining = remainingSeries(cards, completed), eligible = new Set(remaining), holdings = new Set(owned);
  const missing = cards.filter(c => eligible.has(c.universe) && !holdings.has(c.id)).sort((a, b) => compareIds(a.id, b.id));
  check(missing.every(c => /^[0-9]+$/.test(c.id)), 'Batch prices require numeric card IDs');
  for (let start = 0; start < missing.length; start += 200) {
    const batch = missing.slice(start, start + 200), ids = batch.map(c => c.id);
    const prices = parsePrices(await client.get(`/me/collection/prices?ids=${ids.join(',')}`), ids);
    for (const card of batch) { card.median7d = prices[card.id]?.median7d ?? null; card.median30d = prices[card.id]?.median30d ?? null; }
    progress(`Series prices: ${Math.min(start + 200, missing.length)}/${missing.length} missing cards`);
  }
  return validateSeries({ schema_version: 1, collected_at: new Date().toISOString(), cards, owned,
    completed_series: completed, remaining_series: remaining });
}

export function solveSeries(input: unknown, window: '7d' | '30d' = '7d'): SeriesResult {
  check(window === '7d' || window === '30d', 'Median window must be 7d or 30d');
  const state = validateSeries(input), owned = new Set(state.owned);
  const result: SeriesResult = { status: 'NO_ELIGIBLE_SERIES', solver: 'exact enumeration', collected_at: state.collected_at,
    window, ranking: [], best: null, excluded: [], warnings: [
      'Historical medians estimate purchase costs; current listings, availability and future prices may differ.',
      'Purchase order does not change the estimated total. Missing cards are listed cheapest first; ties use card ID.',
    ] };
  if (state.synthetic) result.warnings.push('Synthetic fixture: not live Kyara data.');
  if (Date.now() - Date.parse(state.collected_at) > 86400000) result.warnings.push('Series snapshot is older than 24 hours; sync missions, holdings and prices again.');
  const groups = new Map<string, SeriesCard[]>();
  for (const card of state.cards) {
    if (!groups.has(card.universe)) groups.set(card.universe, []);
    groups.get(card.universe)!.push(card);
  }
  const completed = new Set(state.completed_series);
  for (const [universe, cards] of [...groups].sort(([a], [b]) => compareIds(a, b))) {
    const reasons: string[] = [];
    if (cards.length < 5) reasons.push('Fewer than 5 characters');
    if (completed.has(universe)) reasons.push('Already completed in missions');
    const missing = cards.filter(c => !owned.has(c.id));
    const unknown = missing.filter(c => c[`median${window}`] === null);
    if (unknown.length) reasons.push(`Missing ${window} prices for cards: ${unknown.map(c => c.id).sort(compareIds).join(', ')}`);
    if (reasons.length) { result.excluded.push({ universe, reasons }); continue; }
    const purchases = missing.map(c => ({ id: c.id, name: c.name, price: c[`median${window}`]! }))
      .sort((a, b) => a.price - b.price || compareIds(a.id, b.id));
    const total = purchases.reduce((sum, c) => sum + c.price, 0);
    number(total, 'series total cost');
    result.ranking.push({ universe, total_cards: cards.length, owned_cards: cards.length - missing.length, total_cost: total, missing_cards: purchases });
  }
  result.ranking.sort((a, b) => a.total_cost - b.total_cost || compareIds(a.universe, b.universe));
  result.best = result.ranking[0] ?? null;
  if (result.best) result.status = result.best.missing_cards.length ? 'OPTIMAL' : 'SERIES_READY';
  return result;
}
