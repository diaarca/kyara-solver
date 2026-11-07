import { check, identifier, type Json, type Dataset } from './types';
import { index, parsePrices, normalizeRaw, normalizeRebirth } from './data';

export function allowedPath(path: string): boolean {
  return /^\/(characters|packs|rates|config)$/.test(path)
    || /^\/packs\/[A-Za-z0-9_-]+\/characters$/.test(path)
    || /^\/characters\/[0-9]+$/.test(path)
    || /^\/me\/collection\/prices\?ids=[0-9]+(?:,[0-9]+){0,199}$/.test(path)
    || /^\/market\/prices\/[0-9]+$/.test(path) || path === '/me/wishlist'
    || path === '/me/renaissance?fresh=1' || path === '/me/collection?lean=1';
}

// Serialized into the Kyara tab; do not reference extension variables here.
export async function pageRequest(path: string) {
  if (location.origin !== 'https://kyara.games') return { error: 'Wrong tab origin' };
  const allowed = /^\/(characters|packs|rates|config)$/.test(path)
    || /^\/packs\/[A-Za-z0-9_-]+\/characters$/.test(path)
    || /^\/characters\/[0-9]+$/.test(path)
    || /^\/me\/collection\/prices\?ids=[0-9]+(?:,[0-9]+){0,199}$/.test(path)
    || /^\/market\/prices\/[0-9]+$/.test(path) || path === '/me/wishlist'
    || path === '/me/renaissance?fresh=1' || path === '/me/collection?lean=1';
  if (!allowed) return { error: 'Unsupported data route' };
  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    const token = localStorage.getItem('kyara_token'), device = localStorage.getItem('kyara_device');
    if (token) headers.Authorization = `Bearer ${token}`;
    if (device) headers['x-device-id'] = device;
    const response = await fetch(`/api${path}`, { method: 'GET', headers, credentials: 'same-origin',
      redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(30000) });
    if (!response.ok) return { status: response.status, retryAfter: response.headers.get('Retry-After') };
    if (!response.headers.get('content-type')?.includes('json')) return { error: 'Expected JSON; check the Kyara tab for a login or verification page' };
    return { status: 200, body: await response.json() };
  } catch { return { error: 'Request failed; check the Kyara tab and your connection' }; }
}

export class KyaraClient {
  private lastStart = 0;
  constructor(private tabId: number, private signal: AbortSignal, private progress: (message: string) => void) {}
  private async pause(ms: number) {
    this.signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const stop = () => { clearTimeout(timer); reject(new Error('Collection cancelled')); };
      const timer = setTimeout(() => { this.signal.removeEventListener('abort', stop); resolve(); }, ms);
      this.signal.addEventListener('abort', stop, { once: true });
    });
  }
  async get(path: string): Promise<any> {
    check(allowedPath(path), 'Unsupported data route');
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.pause(Math.max(0, 1100 - (Date.now() - this.lastStart)));
      this.lastStart = Date.now(); this.progress(`Reading ${path.split('?')[0]}…`);
      const replies = await chrome.scripting.executeScript({ target: { tabId: this.tabId }, world: 'MAIN', func: pageRequest, args: [path] });
      this.signal.throwIfAborted(); const reply = replies[0]?.result;
      check(reply && !reply.error, reply?.error ?? 'No response from the Kyara tab');
      if (reply.status === 200) return reply.body;
      if ([429, 500, 502, 503, 504].includes(reply.status ?? 0) && attempt < 2) {
        const header = reply.retryAfter;
        const delay = header ? (/^\d+$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now()) : 2000 * (attempt + 1);
        check(Number.isFinite(delay) && delay <= 60000, 'Kyara asks to wait; try updating later');
        this.progress(`Kyara is busy; retrying shortly (${attempt + 1}/2)…`); await this.pause(Math.max(1000, delay)); continue;
      }
      throw new Error(`Kyara returned HTTP ${reply.status}. Open the Kyara tab to check login or availability.`);
    }
    throw new Error('Kyara did not respond');
  }
}

export async function kyaraTab(): Promise<number> {
  const tabs = await chrome.tabs.query({ url: 'https://kyara.games/*' });
  const tab = tabs.find(t => t.active) ?? tabs[0];
  check(tab?.id !== undefined, 'Open kyara.games and log in before collecting data'); return tab.id;
}

export async function collectMarket(client: Pick<KyaraClient, 'get'>, previous: Json | undefined, full: boolean,
  progress: (message: string) => void, checkpoint: (raw: Json) => Promise<void> = async () => {}) {
  let raw: Json;
  if (full || !previous) {
    const catalog = await client.get('/characters'), packs = await client.get('/packs');
    const cards = index(catalog, 'catalogue'), packMap = index(packs, 'boosters');
    const rates = await client.get('/rates'), config = await client.get('/config');
    raw = { catalog, packs, pack_pools: {}, characters: {}, prices: {}, rules: { rates,
      config: Object.fromEntries(['catalogSize', 'dropWeights', 'pity', 'golden', 'godPackChance', 'godPackSlots', 'recycle']
        .filter(k => Object.hasOwn(config, k)).map(k => [k, config[k]])) }, metadata_collected_at: new Date().toISOString() };
    for (const [id, pack] of packMap) {
      check(/^[A-Za-z0-9_-]+$/.test(id), 'Invalid booster ID');
      const pool = await client.get(`/packs/${id}/characters`);
      check(Array.isArray(pool), 'Invalid pool'); const ids = pool.map(identifier);
      check(ids.length === pack.rates?.poolSize && ids.length === new Set(ids).size && ids.every(cid => cards.has(cid)), `Incomplete pool ${id}`);
      raw.pack_pools[id] = ids;
    }
    const samples = new Set<string>();
    for (const pool of Object.values(raw.pack_pools) as string[][]) {
      const rarities = new Set<string>();
      for (const id of pool) { const r = cards.get(id)!.rarity; if (!rarities.has(r)) { rarities.add(r); samples.add(id); } }
    }
    let done = 0;
    for (const id of [...samples].sort()) {
      raw.characters[id] = await client.get(`/characters/${id}`);
      progress(`Checking published odds: ${++done}/${samples.size} cards`);
    }
    await checkpoint(raw);
  } else raw = structuredClone(previous);
  const ids = [...index(raw.catalog, 'catalogue').keys()].sort();
  check(ids.every(id => /^[0-9]+$/.test(id)), 'Batch prices require numeric card IDs');
  raw.prices = {}; // Never carry old prices forward as fresh observations.
  for (let start = 0; start < ids.length; start += 200) {
    const batch = ids.slice(start, start + 200);
    Object.assign(raw.prices, parsePrices(await client.get(`/me/collection/prices?ids=${batch.join(',')}`), batch));
    progress(`Prices: ${Math.min(start + 200, ids.length)}/${ids.length} cards`);
    await checkpoint(raw);
  }
  raw.collected_at = new Date().toISOString();
  const dataset = await normalizeRaw(raw);
  return { raw, dataset };
}

export async function collectAccount(client: Pick<KyaraClient, 'get'>, dataset: Dataset) {
  const status = await client.get('/me/renaissance?fresh=1');
  const inventory = await client.get('/me/collection?lean=1');
  return normalizeRebirth(status, inventory, dataset);
}
