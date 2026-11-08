import type { Highs } from 'highs';
import { choiceModel, selectChoice } from './choice';
import {
  check,
  object,
  number,
  integer,
  identifier,
  timestamp,
  compareIds,
  type Json,
} from './types';
import { index } from './data';

export interface DailyPrice {
  day: string;
  median: number | null;
  n: number;
}
export interface WishlistCard {
  id: string;
  name: string;
  universe: string;
  collected_at: string;
  days: DailyPrice[];
}
export interface WishlistState {
  schema_version: 1;
  collected_at: string;
  synthetic?: boolean;
  cards: WishlistCard[];
}
export interface WishlistOptions {
  lookback_days: number;
  metric: 'absolute' | 'percent';
}
export interface WishlistRow {
  id: string;
  name: string;
  universe: string;
  collected_at: string;
  start_day: string;
  end_day: string;
  elapsed_days: number;
  start_median: number;
  end_median: number;
  start_sales: number;
  end_sales: number;
  increase: number;
  increase_percent: number | null;
  signal: number;
  score: number;
  eligible: boolean;
}
export interface WishlistResult {
  status: 'OPTIMAL' | 'NO_RISING_CARDS' | 'NO_ELIGIBLE_CARD';
  solver: string;
  collected_at: string;
  metric: string;
  lookback_days: number;
  window_start: string;
  window_end: string;
  ranking: WishlistRow[];
  best: WishlistRow | null;
  excluded: { id: string; reasons: string[] }[];
  warnings: string[];
  model: string;
}
const DAY = 86400000;
function dayMillis(value: unknown): number {
  check(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value), 'Invalid daily date');
  const ms = Date.parse(value + 'T00:00:00Z');
  check(
    Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value,
    'Invalid daily date',
  );
  return ms;
}
function captureTime(value: unknown): string {
  const t = timestamp(value);
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(t);
  check(
    m && Number(m[2]) < 24 && Number(m[3]) < 60 && Number(m[4]) < 60,
    'Capture time requires an ISO timestamp and timezone',
  );
  dayMillis(m[1]);
  return t;
}
export function validateWishlist(input: unknown): WishlistState {
  object(input, 'Wishlist');
  check(input.schema_version === 1 && Array.isArray(input.cards), 'Unsupported wishlist snapshot');
  captureTime(input.collected_at);
  const ids = new Set<string>();
  const cards: WishlistCard[] = input.cards.map((card: Json) => {
    object(card, 'Wishlist card');
    const id = identifier(card.id);
    check(/^[0-9]+$/.test(id) && !ids.has(id), 'Unknown or duplicate wishlist ID');
    ids.add(id);
    check(
      typeof card.name === 'string' &&
        typeof card.universe === 'string' &&
        Array.isArray(card.days),
      'Invalid wishlist card',
    );
    captureTime(card.collected_at);
    check(
      Date.parse(card.collected_at) <= Date.parse(input.collected_at),
      'Card captured after snapshot',
    );
    const seen = new Set<string>();
    const days: DailyPrice[] = card.days.map((row: Json) => {
      object(row, 'Daily price');
      dayMillis(row.day);
      check(!seen.has(row.day), 'Duplicate daily price');
      seen.add(row.day);
      return {
        day: row.day,
        median: row.median === null ? null : number(row.median, 'daily median'),
        n: integer(row.n, 'sale count'),
      };
    });
    return {
      id,
      name: card.name,
      universe: card.universe,
      collected_at: card.collected_at,
      days: days.sort((a, b) => compareIds(a.day, b.day)),
    };
  });
  return {
    schema_version: 1,
    collected_at: input.collected_at,
    synthetic: !!input.synthetic,
    cards,
  };
}
export async function collectWishlist(
  client: { get(path: string): Promise<any> },
  progress: (s: string) => void = () => {},
): Promise<WishlistState> {
  const catalog = index(await client.get('/characters'), 'catalogue'),
    ids: unknown = await client.get('/me/wishlist');
  check(Array.isArray(ids), 'Wishlist must be an array of card IDs');
  const wanted = ids.map(identifier);
  check(
    new Set(wanted).size === wanted.length &&
      wanted.every((id) => /^[0-9]+$/.test(id) && catalog.has(id)),
    'Unknown or duplicate wishlist card',
  );
  const cards: WishlistCard[] = [];
  for (const id of wanted.sort(compareIds)) {
    const body = await client.get(`/market/prices/${id}`);
    object(body, 'Price history');
    check(
      identifier(body.characterId) === id && Array.isArray(body.days),
      'Price history does not match requested card',
    );
    const card = catalog.get(id)!;
    cards.push({
      id,
      name: card.name,
      universe: card.series,
      days: body.days,
      collected_at: new Date().toISOString(),
    });
    progress(`Wishlist prices: ${cards.length}/${wanted.length}`);
  }
  return validateWishlist({ schema_version: 1, collected_at: new Date().toISOString(), cards });
}
export function formulateWishlist(input: unknown, options: WishlistOptions): WishlistResult {
  const state = validateWishlist(input);
  check(
    [1, 7, 30].includes(options.lookback_days) && ['absolute', 'percent'].includes(options.metric),
    'Invalid wishlist options',
  );
  const end = Math.floor(Date.parse(state.collected_at) / DAY) * DAY - DAY,
    start = end - options.lookback_days * DAY;
  const result: WishlistResult = {
    status: 'NO_ELIGIBLE_CARD',
    solver: 'HiGHS (WebAssembly)',
    collected_at: state.collected_at,
    metric: options.metric,
    lookback_days: options.lookback_days,
    window_start: new Date(start).toISOString().slice(0, 10),
    window_end: new Date(end).toISOString().slice(0, 10),
    ranking: [],
    best: null,
    excluded: [],
    model: '',
    warnings: [
      'Observed daily-median increases are not a forecast of future prices or a guaranteed purchase price.',
      'Only completed UTC days with sales are compared; sparse history may cover less than the selected window.',
    ],
  };
  if (state.synthetic) result.warnings.push('Synthetic fixture: not live Kyara data.');
  if (Date.now() - Date.parse(state.collected_at) > DAY)
    result.warnings.push('Wishlist snapshot is older than 24 hours.');
  for (const card of [...state.cards].sort((a, b) => compareIds(a.id, b.id))) {
    const observations = card.days.filter(
      (d) => d.n > 0 && d.median !== null && dayMillis(d.day) >= start && dayMillis(d.day) <= end,
    );
    if (observations.length < 2) {
      result.excluded.push({
        id: card.id,
        reasons: ['Need two dated medians with sales within the selected window'],
      });
      continue;
    }
    const first = observations[0],
      last = observations.at(-1)!;
    const increase = last.median! - first.median!,
      percent = first.median! > 0 ? (100 * increase) / first.median! : null;
    if (options.metric === 'percent' && percent === null) {
      result.excluded.push({
        id: card.id,
        reasons: ['Percentage increase needs a positive baseline'],
      });
      continue;
    }
    const signal = options.metric === 'percent' ? percent! : increase;
    check(
      Number.isFinite(signal) && (percent === null || Number.isFinite(percent)),
      'Price increase overflow',
    );
    result.ranking.push({
      id: card.id,
      name: card.name,
      universe: card.universe,
      collected_at: card.collected_at,
      start_day: first.day,
      end_day: last.day,
      elapsed_days: (dayMillis(last.day) - dayMillis(first.day)) / DAY,
      start_median: first.median!,
      end_median: last.median!,
      start_sales: first.n,
      end_sales: last.n,
      increase,
      increase_percent: percent,
      signal,
      score: 0,
      eligible: signal > 0,
    });
  }
  const rising = result.ranking.filter((r) => r.eligible);
  if (!rising.length) {
    if (result.ranking.length) result.status = 'NO_RISING_CARDS';
    return result;
  }
  check(rising.length <= 1000000, 'Too many wishlist cards');
  const max = Math.max(...rising.map((r) => r.signal));
  rising.forEach((row) => (row.score = Math.round(1000000 * (row.signal / max))));
  result.model = choiceModel(rising, 'y', 'priority');
  return result;
}
export function solveWishlist(
  highs: Highs,
  state: unknown,
  options: WishlistOptions,
): WishlistResult {
  const result = formulateWishlist(state, options);
  if (!result.model) return result;
  const winner = selectChoice(
    highs,
    result.ranking.filter((r) => r.eligible),
    result.model,
    'y',
  );
  result.ranking.sort(
    (a, b) =>
      Number(b.eligible) - Number(a.eligible) ||
      (a.eligible ? b.score - a.score : b.signal - a.signal) ||
      compareIds(a.id, b.id),
  );
  check(winner === result.ranking[0].id, 'HiGHS choice disagrees with ranking');
  result.best = result.ranking[0];
  result.status = 'OPTIMAL';
  return result;
}
