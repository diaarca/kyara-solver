import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture, baselineFixture, rebirth } from './helpers';
import { RARITIES } from '../src/types';

const temporary = await mkdtemp(join(tmpdir(), 'kyara-extension-'));
const extension = resolve(process.env.KYARA_EXTENSION_PATH ?? 'dist');
const context = await chromium.launchPersistentContext(join(temporary, 'profile'), {
  channel: 'chromium', headless: true,
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});
let releasePendingResponse: (() => void) | undefined;
try {
  context.setDefaultTimeout(30000);
  const background = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const id = new URL(background.url()).host;
  const page = await context.newPage(); const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`chrome-extension://${id}/index.html`);
  const backup = join(temporary, 'backup.json');
  await writeFile(backup, JSON.stringify({ dataset: fixture(), rebirth: rebirth() }));
  await page.locator('#import').setInputFiles(backup);
  await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('Dataset imported'));
  await page.locator('#mode').selectOption('paid'); await page.locator('#solve').click();
  await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('Optimal solution'));
  assert.match(await page.locator('#best').innerText(), /Profit pack/);
  await page.locator('#horizon').fill('100'); await page.locator('#solve').click();
  await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('Optimal solution'));
  assert.match(await page.locator('#horizon-summary').innerText(), /100 openings/);
  await page.reload(); await page.waitForFunction(() => (document.querySelector('#horizon') as HTMLInputElement)?.value === '100');
  await page.locator('#horizon').fill('1');
  await page.locator('#goal').selectOption('collection');
  await page.locator('#universes input[value="Black Clover"]').check();
  await page.locator('#solve').click();
  await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('Optimal solution'));
  assert.match(await page.locator('#best').innerText(), /Free-compatible pack/);
  await page.locator('#goal').selectOption('rebirth'); await page.locator('#solve').click();
  await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('Optimal solution'));
  assert.match(await page.locator('#best').innerText(), /Free-compatible pack/);

  // Exercise real script injection and authenticated GETs against mocked Kyara.
  const raw = baselineFixture(); const calls: string[] = []; let pricesFail = false;
  let priceGate: Promise<void> | undefined;
  await context.route('https://kyara.games/**', async route => {
    const req = route.request(), path = new URL(req.url()).pathname.replace(/^\/api/, '');
    if (req.resourceType() === 'document') {
      await route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Mock Kyara</title>' }); return;
    }
    calls.push(new URL(req.url()).pathname + new URL(req.url()).search);
    assert.equal(req.method(), 'GET'); assert.equal(req.headers().authorization, 'Bearer test-token-stays-in-tab');
    let body: unknown;
    if (path === '/characters') body = raw.catalog;
    else if (path === '/packs') body = raw.packs;
    else if (path === '/rates') body = {};
    else if (path === '/config') body = raw.rules.config;
    else if (path === '/packs/base/characters') body = raw.pack_pools.base;
    else if (path.startsWith('/characters/')) body = raw.characters[path.split('/').at(-1)!];
    else if (path === '/me/collection/prices') {
      const gate = priceGate;
      if (gate) await gate;
      if (pricesFail) { await route.fulfill({ status: 403, contentType: 'application/json', body: '{}' }); return; }
      // A cancelled response must never replace the saved prices.
      body = gate ? { '1': { median7d: 999, median30d: 999 }, '2': { median7d: 888, median30d: 888 } } : raw.prices;
    } else if (path === '/me/renaissance') body = { next: 2, requirements: RARITIES.map(r => ({ key: r === 'L' ? 'legendaries' : r === 'M' ? 'mythics' : r,
      have: 0, need: r === 'C' || r === 'R' ? 1 : 0 })) };
    else if (path === '/me/collection') body = [];
    else throw new Error(`Unexpected request ${req.url()}`);
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  const kyara = await context.newPage(); await kyara.goto('https://kyara.games/');
  await kyara.evaluate(() => localStorage.setItem('kyara_token', 'test-token-stays-in-tab'));
  await page.locator('#full').click();
  await page.waitForFunction(() => document.querySelector('#status')?.textContent === 'Data updated.', undefined, { timeout: 60000 });
  await page.locator('#account').click();
  await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('requirements synced'));
  await page.locator('#mode').selectOption('free'); await page.locator('#solve').click();
  await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('Optimal solution'));
  assert.match(await page.locator('#best').innerText(), /Baseline/);
  assert.ok(calls.some(p => p === '/api/me/collection/prices?ids=1,2'));
  const snapshot = await page.locator('#snapshot').innerText();
  const stored = await page.evaluate(async () => JSON.stringify(await chrome.storage.local.get(null)));
  assert.ok(!stored.includes('test-token-stays-in-tab'));
  pricesFail = true; const before = calls.length; await page.locator('#refresh').click();
  await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('HTTP 403'));
  assert.equal(calls.length, before + 1); assert.equal(await page.locator('#snapshot').innerText(), snapshot);
  pricesFail = false;
  const readSavedDataset = () => page.evaluate(async () => {
    const { state } = await chrome.storage.local.get('state');
    return (state as { dataset: unknown }).dataset;
  });
  const savedDataset = await readSavedDataset();
  for (const cancelDelay of [0, 1000]) {
    priceGate = new Promise<void>(resolve => { releasePendingResponse = resolve; });
    const requestStarted = kyara.waitForRequest(req => new URL(req.url()).pathname === '/api/me/collection/prices');
    const callsBeforeCancel = calls.length;
    try {
      await Promise.all([requestStarted, page.locator('#refresh').click()]);
      await page.locator('#cancel').waitFor({ state: 'visible' });
      // Exercise a slow interaction beyond the former 500 ms race window.
      // The response gate, rather than elapsed time, controls completion.
      if (cancelDelay) await delay(cancelDelay);
      await page.locator('#cancel').click();
      await page.waitForFunction(() => document.querySelector('#status')?.textContent === 'Cancelling after the current request…');
      assert.equal(await page.locator('#solve').isDisabled(), true);
    } finally {
      releasePendingResponse?.(); releasePendingResponse = undefined; priceGate = undefined;
    }
    await page.locator('#cancel').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#solve').isEnabled(), true);
    assert.equal(await page.locator('#refresh').isEnabled(), true);
    assert.equal(await page.locator('#import').isEnabled(), true);
    assert.match(await page.locator('#status').innerText(), /abort|cancel/i);
    assert.equal(calls.length, callsBeforeCancel + 1);
    assert.equal(await page.locator('#snapshot').innerText(), snapshot);
    assert.deepEqual(await readSavedDataset(), savedDataset);
  }
  await page.reload(); await page.waitForFunction(() => document.querySelector('#snapshot')?.textContent?.includes('2 cards'));
  assert.deepEqual(await readSavedDataset(), savedDataset);
  assert.match(await page.locator('#account-status').innerText(), /next rebirth 2/);
  await page.locator('#solve').click();
  await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('Optimal solution'));
  await page.screenshot({ path: join(tmpdir(), 'kyara-extension.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log('Browser extension passed: HiGHS WASM, all objectives, collection, account sync, credential isolation, failure preservation, and reload.');
} finally {
  releasePendingResponse?.();
  await context.unrouteAll({ behavior: 'wait' });
  await context.close(); await rm(temporary, { recursive: true, force: true });
}
