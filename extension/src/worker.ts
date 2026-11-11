import loadHighs from 'highs';
import { solve } from './model';
import { solveWishlist } from './wishlist';
import { solveSeries } from './series';
const highs = loadHighs({ locateFile: () => new URL('./vendor/highs.wasm', import.meta.url).href });
self.onmessage = async ({ data }) => {
  try {
    self.postMessage({
      result:
        data.kind === 'series'
          ? solveSeries(data.series, data.window)
          : data.kind === 'wishlist'
            ? solveWishlist(await highs, data.wishlist, data.options)
            : solve(await highs, data.dataset, data.options),
    });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
