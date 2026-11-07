export const RARITIES = ['C', 'U', 'R', 'E', 'L', 'M'] as const;
export type Rarity = typeof RARITIES[number];
export type Json = Record<string, any>;
export interface Slot { draws: number; probabilities: Record<string, number> }
export interface ProbabilityModel { type: string; slots?: Slot[]; cards?: Record<string, { expected_copies: number; occurrence_probability: number }> }
export interface Outcome { card_id: string; expected_copies: number; occurrence_probability: number }
export interface Card { id: string; name: string; universe: string; rarity: Rarity; median7d: number | null; median30d: number | null }
export interface Booster {
  id: string; name: string; cost: number | null; available: boolean; uses_free_packs: boolean;
  issues: string[]; outcomes: Outcome[]; verification?: { model: ProbabilityModel; [key: string]: any } | null;
}
export interface Dataset {
  schema_version: number; snapshot_id: string; collected_at: string; synthetic?: boolean;
  cards: Card[]; boosters: Booster[]; metadata_collected_at?: string;
}
export interface Rebirth {
  schema_version: number; counting: string; collected_at: string; next_rebirth: number;
  owned: string[]; requirements: Record<Rarity, { current: number; target: number }>;
}
export interface Options {
  horizon?: number; mode: 'free' | 'paid'; goal: 'profit' | 'collection' | 'rebirth'; weight: number;
  window: '7d' | '30d'; fee: number; universes: string[]; owned: string[]; rebirth?: Rebirth;
}
export interface Candidate {
  id: string; name: string; cost: number; total_cost: number; expected_profit: number | null;
  progress: number; normalized_profit: number; normalized_progress: number; score: number;
  price_coverage: { known: number; total: number }; rebirth_by_rarity?: Json;
}
export interface Result {
  status: 'OPTIMAL' | 'NO_ELIGIBLE_BOOSTER' | 'REBIRTH_RARITY_TARGETS_MET'; solver: string;
  snapshot_id: string; collected_at: string; horizon: number; ranking: Candidate[]; best: Candidate | null;
  excluded: { id: string; reasons: string[] }[]; warnings: string[];
  recommend_paid_purchase: boolean | null; model: string;
}
export function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
export function object(value: unknown, label = 'Object'): asserts value is Json {
  check(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
}
export function number(value: unknown, label: string, max = Infinity): number {
  check(typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max, `Invalid ${label}`);
  return value;
}
export function integer(value: unknown, label: string, max = Number.MAX_SAFE_INTEGER): number {
  const n = number(value, label, max); check(Number.isSafeInteger(n), `Invalid ${label}`); return n;
}
export function identifier(value: unknown): string {
  check((typeof value === 'string' && value.length > 0) || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0), 'Invalid card/booster ID');
  return String(value);
}
export function timestamp(value: unknown): string {
  check(typeof value === 'string' && Number.isFinite(Date.parse(value)), 'Invalid capture time'); return value;
}
export const compareIds = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
