import { build } from 'esbuild';
import { cp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
await rm('dist', { recursive: true, force: true });
await mkdir('dist/vendor', { recursive: true });
await build({
  entryPoints: ['src/app.ts', 'src/worker.ts', 'src/background.ts'],
  bundle: true, format: 'esm', platform: 'browser', target: 'chrome120', outdir: 'dist',
  plugins: [{ name: 'packaged-highs', setup(b) {
    b.onResolve({ filter: /^highs$/ }, () => ({ path: './vendor/highs.mjs', external: true }));
  }}],
});
for (const file of ['manifest.json', 'index.html', 'style.css']) await cp(file, `dist/${file}`);
for (const file of ['highs.mjs', 'highs.wasm']) await cp(`node_modules/highs/build/${file}`, `dist/vendor/${file}`);
const license = await readFile('node_modules/highs/package.json', 'utf8');
await writeFile('dist/vendor/NOTICE.txt', `HiGHS / highs-js: MIT license.\nhttps://github.com/lovasoa/highs-js\nhttps://github.com/ERGO-Code/HiGHS\n\nPackage metadata:\n${license}`);
// Include the complete upstream license text with distributed binaries.
await cp('THIRD_PARTY_LICENSES.txt', 'dist/THIRD_PARTY_LICENSES.txt');
