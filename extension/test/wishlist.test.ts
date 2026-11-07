import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import loadHighs from 'highs';
import { collectWishlist, solveWishlist, validateWishlist, type WishlistState } from '../src/wishlist';
import { allowedPath } from '../src/collect';
import { root } from './helpers';
const state: WishlistState = JSON.parse(readFileSync(join(root,'tests/fixtures/wishlist.json'),'utf8'));
const highs = await loadHighs();
const run = (metric: 'absolute' | 'percent' = 'percent', lookback_days = 7, data = state) => solveWishlist(highs, data, { metric, lookback_days });

test('absolute and percentage signals choose different priorities with actual dates and sale counts', () => {
  assert.equal(run('absolute').best!.id, '1'); const r = run(); assert.equal(r.best!.id, '2');
  assert.equal(r.best!.increase, 20); assert.equal(r.best!.increase_percent, 200); assert.equal(r.best!.elapsed_days, 7);
  assert.equal(r.best!.start_sales, 10); assert.equal(r.best!.end_sales, 12); assert.match(r.model, /Binary/);
  assert.equal(r.ranking.find(c => c.id === '1')!.end_median, 200);
});
test('UTC capture time, sparse and zero-sales days, null medians and zero baselines', () => {
  assert.ok(run().excluded.some(c => c.id === '4')); assert.ok(run().excluded.some(c => c.id === '5')); assert.ok(run().excluded.some(c => c.id === '6'));
  assert.ok(run('absolute').ranking.some(c => c.id === '5'));
  const d = structuredClone(state); d.collected_at = '2026-11-08T00:30:00+02:00';
  assert.equal(run('percent',7,d).window_end, '2026-11-06');
  const thirty = run('percent',30); assert.equal(thirty.best!.id,'6'); assert.equal(thirty.best!.elapsed_days,8);
  const one = run('percent',1); assert.equal(one.best!.increase_percent, 50);
  const nullable = structuredClone(state); nullable.cards[0].days[0].median = null;
  assert.equal(run('absolute',7,nullable).ranking.find(c=>c.id==='1')!.start_day, '2026-11-05');
});
test('empty, flat and falling wishlists do not recommend purchases; positive ties use card ID', () => {
  const d = structuredClone(state); d.cards = [];
  assert.equal(run('percent',7,d).status, 'NO_ELIGIBLE_CARD');
  d.cards = [structuredClone(state.cards[2])]; assert.equal(run('percent',7,d).status,'NO_RISING_CARDS');
  d.cards[0].days[1].median = 20; assert.equal(run('absolute',7,d).best,null);
  d.cards = [structuredClone(state.cards[0]), {...structuredClone(state.cards[0]),id:'10'}]; assert.equal(run('absolute',7,d).best!.id,'1');
});
test('bad snapshots and options are rejected', () => {
  for (const change of ['duplicate','date','sales','future-capture']) {
    const d = structuredClone(state);
    if(change==='duplicate')d.cards.push(d.cards[0]);
    if(change==='date')d.cards[0].days[0].day='2026-02-30';
    if(change==='sales')d.cards[0].days[0].n=-1;
    if(change==='future-capture')d.cards[0].collected_at='2026-11-08T00:00:00Z';
    assert.throws(()=>validateWishlist(d));
  }
  assert.throws(()=>run('percent',2));
});
test('wishlist collection is independent of boosters, strips unrelated fields and rejects incomplete updates', async () => {
  const calls: string[] = [];
  const client={async get(path: string) {
    calls.push(path);
    if(path==='/characters')return [{id:1,name:'Test',series:'Fixture'}];
    if(path==='/me/wishlist')return [1];
    if(path==='/market/prices/1')return {characterId:1,days:state.cards[0].days,token:'must not export',lastSales:[{account:'private'}]};
    throw new Error('Unexpected route');
  }};
  const d=await collectWishlist(client); assert.deepEqual(calls,['/characters','/me/wishlist','/market/prices/1']);
  assert.ok(!JSON.stringify(d).includes('must not export')); assert.ok(!JSON.stringify(d).includes('private'));
  await assert.rejects(collectWishlist({async get(path){if(path==='/market/prices/1')throw new Error('offline');return client.get(path);}}));
  for(const path of ['/me/wishlist','/market/prices/123'])assert.ok(allowedPath(path));
  for(const path of ['/me/wishlist/123','/me/wishlist/series','/market/prices/123?token=secret'])assert.ok(!allowedPath(path));
});
test('HiGHS wishlist rankings match C++ CP-SAT for all periods and metrics', {skip: !process.env.KYARA_SOLVER}, () => {
  const dir=mkdtempSync(join(tmpdir(),'kyara-wishlist-parity-'));
  try {
    const path=join(dir,'wishlist.json');writeFileSync(path,JSON.stringify(state));
    for(const lookback of [1,7,30])for(const metric of ['absolute','percent'] as const) {
      const cli=spawnSync(process.env.KYARA_SOLVER!,['wishlist','--wishlist-state',path,'--lookback-days',String(lookback),'--metric',metric,'--format','json'],{encoding:'utf8'});
      assert.equal(cli.status,0,cli.stderr);const cpp=JSON.parse(cli.stdout),ts=run(metric,lookback);
      assert.equal(cpp.best?.id,ts.best?.id);assert.equal(cpp.status,ts.status);
      assert.deepEqual(cpp.ranking,ts.ranking);
    }
  } finally {rmSync(dir,{recursive:true,force:true});}
});
