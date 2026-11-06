import loadHighs from 'highs';
import { solve } from './model';
const highs = loadHighs({ locateFile: () => new URL('./vendor/highs.wasm', import.meta.url).href });
self.onmessage = async ({ data }) => {
  try { self.postMessage({ result: solve(await highs, data.dataset, data.options) }); }
  catch (e) { self.postMessage({ error: (e as Error).message }); }
};
