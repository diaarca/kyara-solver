import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { type Dataset, type Json, type Options, type Rebirth, RARITIES } from '../src/types';
export const root = fileURLToPath(new URL('../../', import.meta.url));
export function python(code: string) {
  const executable = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
  const p = spawnSync(executable, ['-c', code], { cwd: root, encoding: 'utf8', env: { ...process.env, PYTHONPATH: join(root, 'python') } });
  if (p.status !== 0) throw new Error(p.stderr); return JSON.parse(p.stdout);
}
export function fixture(): Dataset {
  return python("import json; from pathlib import Path; from kyara.collector import normalize; print(json.dumps(normalize(json.loads(Path('tests/fixtures/raw.json').read_text()),json.loads(Path('tests/fixtures/verification.json').read_text()))))");
}
export const options = (extra: Partial<Options> = {}): Options => ({ mode: 'paid', goal: 'profit', weight: 1, window: '7d', fee: 0, universes: [], owned: [], ...extra });
export function rebirth(): Rebirth {
  return { schema_version: 1, counting: 'unique', next_rebirth: 2, collected_at: '2026-11-06T12:00:00Z', owned: ['1'],
    requirements: Object.fromEntries(RARITIES.map(r => [r, { current: r === 'R' ? 1 : 0, target: r === 'R' ? 2 : r === 'M' ? 1 : 0 }])) as Rebirth['requirements'] };
}
export function baselineFixture(): Json {
  const z = Object.fromEntries(RARITIES.map(r => [r, 0]));
  return { collected_at: '2026-11-06T12:00:00Z', catalog: [
    { id: 1, name: 'Common', series: 'Fixture', rarity: 'C' }, { id: 2, name: 'Rare', series: 'Fixture', rarity: 'R' }],
    packs: [{ id: 'base', name: 'Baseline', chakraPrice: 10, usesFreePacks: true, slots: ['C', 'R'], rates: {
      poolSize: 2, cardsByRarity: { ...z, C: 1, R: 1 },
      slots: [{ min: 'C', pct: { ...z, C: 75, R: 25 } }, { min: 'R', pct: { ...z, R: 100 } }],
      perBooster: Object.fromEntries(RARITIES.map(r => [r, { expected: r === 'C' ? .75 : r === 'R' ? 1.25 : 0,
        atLeastOnePct: r === 'C' ? 75 : r === 'R' ? 100 : 0, perCardPct: r === 'C' ? 75 : r === 'R' ? 100 : 0 }])) } }],
    pack_pools: { base: [1, 2] }, rules: { rates: {}, config: { dropWeights: { ...z, C: 3, R: 1 } } },
    characters: { '1': { id: 1, rarity: 'C', dropChance: { base: .75 } }, '2': { id: 2, rarity: 'R', dropChance: { base: 1 } } },
    prices: { '1': { median7d: 4, median30d: 4 }, '2': { median7d: 8, median30d: 8 } } };
}
