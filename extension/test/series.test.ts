import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { collectSeries, solveSeries, validateSeries, type SeriesState } from '../src/series';
import { allowedPath } from '../src/collect';
import { root } from './helpers';

const fixture: SeriesState = JSON.parse(readFileSync(join(root, 'tests/fixtures/series.json'), 'utf8'));

test('minimizes total missing-card cost, uses holdings, and excludes small, completed and unknown series', () => {
  const r = solveSeries(fixture);
  assert.equal(r.best?.universe, 'Almost there');
  assert.equal(r.best?.total_cost, 9);
  assert.deepEqual(r.best?.missing_cards, [{ id: '5', name: 'Almost there 5', price: 9 }]);
  assert.equal(r.best?.owned_cards, 4);
  assert.equal(r.excluded.length, 3);
  assert.equal(solveSeries(fixture, '30d').best?.universe, 'From scratch');
});

test('exact costs and deterministic purchase order; zero prices and already-owned series need no invented prices', () => {
  const d = structuredClone(fixture);
  d.cards[4].median7d = 10.0000001;
  assert.equal(solveSeries(d).best?.universe, 'From scratch');
  d.cards[4].median7d = 10;
  assert.equal(solveSeries(d).best?.universe, 'Almost there');
  d.cards[4].median7d = 0;
  assert.equal(solveSeries(d).best?.total_cost, 0);
  assert.equal(solveSeries(d).status, 'OPTIMAL');
  d.cards[4].median7d = null;
  d.owned.push('5');
  assert.equal(solveSeries(d).status, 'SERIES_READY');
  const unpriced = structuredClone(fixture);
  for (const card of unpriced.cards) card.median7d = null;
  assert.equal(solveSeries(unpriced).status, 'NO_ELIGIBLE_SERIES');
  d.cards = []; d.owned = []; d.remaining_series = [];
  assert.equal(solveSeries(d).status, 'NO_ELIGIBLE_SERIES');
  const purchases = solveSeries(fixture, '30d').best!.missing_cards;
  assert.deepEqual(purchases.map(c => c.id), ['10', '6', '7', '8', '9']);
});

test('invalid snapshots and inconsistent stored remaining series are rejected', () => {
  for (const change of ['duplicate', 'owned', 'remaining', 'price', 'time', 'missions']) {
    const d = structuredClone(fixture);
    if (change === 'duplicate') d.cards.push(d.cards[0]);
    if (change === 'owned') d.owned.push('999');
    if (change === 'remaining') d.remaining_series = [];
    if (change === 'price') d.cards[0].median7d = -1;
    if (change === 'time') d.collected_at = 'invalid';
    if (change === 'missions') d.completed_series.push('Done');
    assert.throws(() => validateSeries(d));
  }
  assert.throws(() => solveSeries(fixture, '1d' as '7d'));
});

test('missions collection includes unclaimed completions, fetches only eligible missing prices, and strips account fields', async () => {
  const calls: string[] = [];
  const client = { async get(path: string) {
    calls.push(path);
    if (path === '/characters') return fixture.cards.map(c => ({ id: c.id, name: c.name, series: c.universe }));
    if (path === '/me/progress') return { series: [{ series: 'Done', size: 5, claimed: false, completedAt: fixture.collected_at }], private: 'must not export' };
    if (path === '/me/collection?lean=1') return fixture.cards.map(c => ({ characterId: c.id, qty: fixture.owned.includes(c.id) ? 2 : 0 }));
    if (path.startsWith('/me/collection/prices?ids=')) {
      const ids = path.split('=')[1].split(',');
      return fixture.cards.filter(c => ids.includes(c.id)).map(c => ({ characterId: c.id, median7d: c.median7d, median30d: c.median30d }));
    }
    throw new Error('Unexpected route');
  } };
  const state = await collectSeries(client);
  assert.deepEqual(state.remaining_series, fixture.remaining_series);
  assert.deepEqual(state.completed_series, ['Done']);
  assert.deepEqual(calls.slice(0, 3), ['/characters', '/me/progress', '/me/collection?lean=1']);
  assert.deepEqual(new Set(calls[3].split('=')[1].split(',')), new Set(['5', '6', '7', '8', '9', '10', '20', '21', '22', '23', '24']));
  assert.ok(!JSON.stringify(state).includes('must not export'));
  assert.equal(state.cards[0].median7d, null);
  assert.equal(solveSeries(state).best?.universe, 'Almost there');
  await assert.rejects(collectSeries({ async get(path) { return path === '/me/progress' ? {} : client.get(path); } }));
  await assert.rejects(collectSeries({ async get(path) { if (path.startsWith('/me/collection/prices')) throw new Error('offline'); return client.get(path); } }));
  assert.ok(allowedPath('/me/progress'));
  for (const path of ['/me/progress/claim', '/me/progress?token=secret']) assert.ok(!allowedPath(path));
});

test('CLI and browser series results agree, including exact totals, exclusions, ties and ready states', { skip: !process.env.KYARA_SOLVER }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'kyara-series-parity-'));
  try {
    const variants = [structuredClone(fixture), structuredClone(fixture), structuredClone(fixture), structuredClone(fixture)];
    variants[1].cards[4].median7d = 10.0000001;
    variants[2].owned.push('5'); variants[2].cards[4].median7d = null;
    variants[3].cards = []; variants[3].owned = []; variants[3].remaining_series = [];
    for (const data of variants) for (const window of ['7d', '30d'] as const) {
      const path = join(dir, 'series.json'); writeFileSync(path, JSON.stringify(data));
      const cli = spawnSync(process.env.KYARA_SOLVER!, ['series', '--series-state', path, '--median-window', window, '--format', 'json'], { encoding: 'utf8' });
      assert.equal(cli.status, 0, cli.stderr);
      const cpp = JSON.parse(cli.stdout), ts = solveSeries(data, window);
      assert.deepEqual(cpp.ranking, ts.ranking); assert.deepEqual(cpp.excluded, ts.excluded);
      assert.deepEqual(cpp.best, ts.best); assert.equal(cpp.status, ts.status);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
