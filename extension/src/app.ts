import { check, object, type Dataset, type Rebirth, type Options, type Json, type Result } from './types';
import { validateDataset, validateRebirth } from './model';
import { KyaraClient, kyaraTab, collectMarket, collectAccount } from './collect';

interface State { dataset?: Dataset; raw?: Json; rebirth?: Rebirth; options?: Options }
let state: State = {}, busy = false, controller: AbortController | undefined, result: Result | undefined;
let worker: Worker | undefined;
let cancelSolve: (() => void) | undefined;
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => el<HTMLInputElement>(id);
const select = (id: string) => el<HTMLSelectElement>(id);
const status = (message: string, error = false) => { el('status').textContent = message; el('status').classList.toggle('error', error); };
const format = (value: number | null, digits = 4) => value === null ? 'Unknown' : value.toLocaleString(undefined, { maximumFractionDigits: digits });
function download(name: string, content: string, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([content], { type })), a = document.createElement('a');
  a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function updateFields() {
  const goal = select('goal').value;
  el('progress-fields').hidden = goal === 'profit';
  el('collection-fields').hidden = goal !== 'collection';
  el('rebirth-help').hidden = goal !== 'rebirth';
  el('manual-owned').hidden = input('use-holdings').checked;
  el('weight-label').textContent = `${input('weight').value}%`;
}
function renderState() {
  const dataset = state.dataset;
  el('snapshot').textContent = dataset ? `${dataset.cards.length.toLocaleString()} cards · prices ${new Date(dataset.collected_at).toLocaleString()} · catalogue ${new Date(dataset.metadata_collected_at ?? dataset.collected_at).toLocaleString()}` : 'No dataset yet. Open Kyara, log in, then update data.';
  el('account-status').textContent = state.rebirth ? `${state.rebirth.owned.length} unique owned cards · next rebirth ${state.rebirth.next_rebirth} · synced ${new Date(state.rebirth.collected_at).toLocaleString()}` : 'Holdings have not been synced.';
  const selected = new Set(state.options?.universes ?? []);
  el('universes').replaceChildren();
  for (const name of [...new Set(dataset?.cards.map(c => c.universe) ?? [])].sort()) {
    const label = document.createElement('label'), checkbox = document.createElement('input');
    checkbox.type = 'checkbox'; checkbox.value = name; checkbox.checked = selected.has(name);
    label.append(checkbox, document.createTextNode(` ${name}`)); el('universes').append(label);
  }
  updateFields();
}
function setBusy(value: boolean) {
  busy = value;
  for (const button of document.querySelectorAll<HTMLButtonElement>('button')) if (button.id !== 'cancel') button.disabled = value;
  input('import').disabled = value;
  el('cancel').hidden = !value;
  el('cancel').textContent = controller ? 'Cancel update' : 'Cancel solve';
}
async function save() { await chrome.storage.local.set({ state }); }
async function task(action: () => Promise<void>) {
  if (busy) return;
  result = undefined; el('results').hidden = true;
  setBusy(true);
  try { await action(); } catch (e) { status((e as Error).message, true); }
  finally { controller = undefined; cancelSolve = undefined; worker?.terminate(); worker = undefined; setBusy(false); }
}
async function updateMarket(full: boolean) {
  await task(async () => {
    controller = new AbortController(); el('cancel').textContent = 'Cancel update';
    const client = new KyaraClient(await kyaraTab(), controller.signal, status);
    const checkpoint = (await chrome.storage.local.get('checkpoint')).checkpoint;
    if (checkpoint !== undefined) object(checkpoint, 'Collection checkpoint');
    const previous = state.raw ?? checkpoint;
    const next = await collectMarket(client, previous, full, status,
      raw => chrome.storage.local.set({ checkpoint: raw }));
    controller.signal.throwIfAborted();
    // Commit only completed snapshots; failed updates preserve the prior dataset.
    const updated = { ...state, ...next };
    await chrome.storage.local.set({ state: updated }); state = updated;
    await chrome.storage.local.remove('checkpoint'); renderState(); status('Data updated.');
  });
}
el('refresh').onclick = () => { void updateMarket(false); };
el('full').onclick = () => { void updateMarket(true); };
el('account').onclick = () => { void task(async () => {
  check(state.dataset, 'Update or import a dataset first'); controller = new AbortController();
  el('cancel').textContent = 'Cancel update';
  const client = new KyaraClient(await kyaraTab(), controller.signal, status);
  const rebirth = await collectAccount(client, state.dataset);
  controller.signal.throwIfAborted();
  const updated = { ...state, rebirth };
  await chrome.storage.local.set({ state: updated }); state = updated;
  renderState(); status('Holdings and rebirth requirements synced.');
}); };
el('cancel').onclick = () => {
  if (controller) { controller.abort(); status('Cancelling after the current request…'); }
  else cancelSolve?.();
};
select('goal').onchange = () => { input('weight').value = '0'; updateFields(); };
input('weight').oninput = updateFields;
input('use-holdings').onchange = updateFields;
input('universe-search').oninput = () => {
  const query = input('universe-search').value.toLocaleLowerCase();
  for (const label of el('universes').querySelectorAll('label')) label.hidden = !label.textContent!.toLocaleLowerCase().includes(query);
};
function options(): Options {
  const goal = select('goal').value as Options['goal'];
  check(state.dataset, 'Update or import a dataset first');
  if (goal === 'collection' && input('use-holdings').checked) check(state.rebirth, 'Sync holdings first, or uncheck “Use synced holdings” to enter card IDs');
  return { horizon: Number(input('horizon').value), goal, mode: select('mode').value as Options['mode'], window: select('window').value as Options['window'],
    weight: goal === 'profit' ? 1 : Number(input('weight').value) / 100, fee: Number(input('fee').value) / 100,
    universes: goal === 'collection' ? [...el('universes').querySelectorAll<HTMLInputElement>('input:checked')].map(c => c.value) : [],
    owned: goal === 'collection' ? input('use-holdings').checked ? state.rebirth!.owned : [...new Set(input('owned').value.split(/[\s,]+/).filter(Boolean))] : [],
    rebirth: goal === 'rebirth' ? state.rebirth : undefined };
}
function showResult(r: Result, o: Options) {
  result = r; el('results').hidden = false;
  el('horizon-summary').textContent = `Expected outcome from ${r.horizon} openings of the same booster type.`;
  el('best').textContent = r.status === 'REBIRTH_RARITY_TARGETS_MET' ? 'All rarity targets are already met.'
    : r.best ? r.recommend_paid_purchase === false ? `No purchase recommended. Best evaluated pack: ${r.best.name}` : `Best booster: ${r.best.name}` : 'No eligible booster. Check the exclusions below.';
  el('ranking').replaceChildren();
  for (const c of r.ranking) {
    const row = document.createElement('tr');
    const progress = o.goal === 'profit' ? '—' : o.goal === 'rebirth' ? `${format(c.progress * 100)}% of remaining gap` : `${format(c.progress)} new cards`;
    for (const text of [c.name, format(c.total_cost), format(c.expected_profit), progress, format(c.score / 1000000), `${c.price_coverage.known}/${c.price_coverage.total}`]) {
      const cell = document.createElement('td'); cell.textContent = text; row.append(cell);
    }
    el('ranking').append(row);
  }
  for (const [id, lines] of [['warnings', r.warnings], ['exclusions', r.excluded.map(e => `${e.id}: ${e.reasons.join('; ')}`)]] as const) {
    el(id).replaceChildren();
    for (const line of lines) { const li = document.createElement('li'); li.textContent = line; el(id).append(li); }
  }
}
el<HTMLFormElement>('parameters').onsubmit = event => {
  event.preventDefault(); void task(async () => {
    const o = options(); state.options = o; await save(); status('Solving locally with HiGHS…');
    const r = await new Promise<Result>((resolve, reject) => {
      worker = new Worker(new URL('worker.js', location.href), { type: 'module' });
      worker.onmessage = ({ data }) => data.error ? reject(new Error(data.error)) : resolve(data.result);
      worker.onerror = () => reject(new Error('Solver worker failed to load. Reload the extension and try again.'));
      worker.postMessage({ dataset: state.dataset, options: o });
      // Cancelling the worker must also settle this task.
      cancelSolve = () => { worker?.terminate(); reject(new Error('Solve cancelled')); };
    });
    showResult(r, o); status(r.status === 'OPTIMAL' ? 'Optimal solution found by HiGHS.' : 'Analysis complete.');
  });
};
input('import').onchange = () => { void task(async () => {
  const file = input('import').files?.[0]; check(file, 'Choose a JSON file');
  const imported: unknown = JSON.parse(await file.text()); object(imported, 'Import');
  const dataset = validateDataset(imported.dataset ?? imported);
  const rebirth = imported.rebirth ? validateRebirth(imported.rebirth, new Map(dataset.cards.map(c => [c.id, c]))) : undefined;
  // Imported raw bundles are deliberately not trusted for future API requests.
  const updated: State = { dataset, rebirth };
  await chrome.storage.local.set({ state: updated }); await chrome.storage.local.remove('checkpoint');
  state = updated; renderState(); status('Dataset imported. Refresh the catalogue before collecting new prices.');
}); input('import').value = ''; };
el('export').onclick = () => {
  if (!state.dataset) { status('No dataset to export', true); return; }
  download('kyara-backup.json', JSON.stringify({ dataset: state.dataset, rebirth: state.rebirth }, null, 2));
};
el('export-result').onclick = () => { if (result) download('kyara-result.json', JSON.stringify({ ...result, options: state.options }, null, 2)); };
el('export-model').onclick = () => { if (result?.model) download('kyara-model.lp', result.model, 'text/plain'); };

async function init() {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  const saved = (await chrome.storage.local.get('state')).state;
  if (saved) {
    object(saved, 'Saved state');
    if (saved.dataset) saved.dataset = validateDataset(saved.dataset);
    if (saved.rebirth && saved.dataset) saved.rebirth = validateRebirth(saved.rebirth, new Map(saved.dataset.cards.map((c: any) => [c.id, c])));
    state = saved;
  }
  renderState();
  if (state.options) {
    input('horizon').value = String(state.options.horizon ?? 1);
    select('mode').value = state.options.mode; select('goal').value = state.options.goal;
    select('window').value = state.options.window; input('fee').value = String(state.options.fee * 100);
    input('weight').value = String(state.options.weight * 100); input('owned').value = state.options.owned.join(', ');
    input('use-holdings').checked = !!state.rebirth; updateFields();
  }
}
void init().catch(e => status(`Could not load saved data: ${e.message}. Import a backup or refresh the catalogue.`, true));
