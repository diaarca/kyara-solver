import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRaw, verifyBaseline, parsePrices, normalizeRebirth } from '../src/data';
import { collectMarket, collectAccount, allowedPath } from '../src/collect';
import { baselineFixture, fixture } from './helpers';
import { RARITIES } from '../src/types';

test('published-rate baseline verifies pool, samples, slots and moments', async () => {
  const raw = baselineFixture(), d = await normalizeRaw(raw);
  assert.deepEqual(d.boosters[0].issues, []);
  assert.equal(d.boosters[0].outcomes[1].expected_copies, 1.25);
  for (const mutation of ['pool', 'sample', 'rates']) {
    const bad = structuredClone(raw);
    if (mutation === 'pool') bad.pack_pools.base.pop();
    if (mutation === 'sample') bad.characters['2'].dropChance.base = .1;
    if (mutation === 'rates') bad.packs[0].rates.perBooster.R.perCardPct = 20;
    assert.throws(() => verifyBaseline(bad, 'base'));
    assert.ok((await normalizeRaw(bad)).boosters[0].issues.length);
  }
});
test('batch parsing preserves nulls and rejects fair prices, missing windows, duplicates', () => {
  assert.deepEqual(parsePrices({ '1': { median7d: null, median30d: 3 } }, ['1']), { '1': { median7d: null, median30d: 3 } });
  for (const value of [{ '1': 50 }, [{ id: 1, median7d: 5 }], [{ id: 2, median7d: 5, median30d: 5 }],
    [{ id: 1, median7d: 5, median30d: 5 }, { id: 1, median7d: 5, median30d: 5 }]]) {
    assert.throws(() => parsePrices(value, ['1']));
  }
});
test('full collection and price-only refresh use batch routes and preserve old inputs', async () => {
  const raw = baselineFixture(), calls: string[] = [];
  const client = { async get(path: string): Promise<any> {
    calls.push(path);
    if (path === '/characters') return raw.catalog;
    if (path === '/packs') return raw.packs;
    if (path === '/rates') return {};
    if (path === '/config') return { ...raw.rules.config, secret: 'must not export' };
    if (path === '/packs/base/characters') return raw.pack_pools.base;
    if (path.startsWith('/characters/')) return raw.characters[path.split('/').at(-1)!];
    if (path.startsWith('/me/collection/prices?')) return raw.prices;
    throw new Error(`Unexpected ${path}`);
  } };
  const next = await collectMarket(client, undefined, true, () => {});
  assert.equal(next.dataset.boosters[0].issues.length, 0); assert.equal(next.raw.rules.config.secret, undefined);
  calls.length = 0;
  const refreshed = await collectMarket(client, next.raw, false, () => {});
  assert.deepEqual(calls, ['/me/collection/prices?ids=1,2']);
  assert.notEqual(refreshed.raw, next.raw);
  const old = structuredClone(next.raw);
  await assert.rejects(collectMarket({ async get() { throw new Error('offline'); } }, next.raw, false, () => {}));
  assert.deepEqual(next.raw, old);
});
test('rebirth sync counts unique cards, ignores other requirements and makes only two GETs', async () => {
  const d = fixture(), calls: string[] = [];
  const status = { next: 9, requirements: RARITIES.map(r => ({ key: r === 'L' ? 'legendaries' : r === 'M' ? 'mythics' : r, have: r === 'R' ? 1 : 0, need: 5 })) };
  const inventory = [{ characterId: 1, qty: 7 }];
  const r = await collectAccount({ async get(path) { calls.push(path); return path.includes('renaissance') ? status : inventory; } }, d);
  assert.deepEqual(r.owned, ['1']); assert.equal(r.requirements.R.current, 1);
  assert.deepEqual(calls, ['/me/renaissance?fresh=1', '/me/collection?lean=1']);
  const bad = structuredClone(status); bad.requirements[0].have = 1;
  assert.throws(() => normalizeRebirth(bad, inventory, d));
  assert.throws(() => normalizeRebirth(status, [...inventory, ...inventory], d));
});
test('collection bridge rejects arbitrary routes, origins and rebirth actions', () => {
  for (const path of ['/characters', '/packs/base/characters', '/me/collection/prices?ids=1,2', '/me/renaissance?fresh=1']) assert.ok(allowedPath(path));
  for (const path of ['https://evil.example/api/characters', '/me/renaissance', '/me/profile', '/packs/../characters', '/characters?token=secret']) assert.ok(!allowedPath(path));
});
