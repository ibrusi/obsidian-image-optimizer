// Browser smoke test of the WebAssembly encoder.
// Usage: node test/browser/run.mjs [chromium,webkit]
// WebKit is the engine of Obsidian on iOS, Chromium of desktop and Android.
import esbuild from 'esbuild';
import { chromium, webkit } from 'playwright';

const engines = { chromium, webkit };
const requested = (process.argv[2] ?? process.env.PROTOTYPE_BROWSERS ?? 'chromium,webkit').split(',');

const { outputFiles } = await esbuild.build({
  entryPoints: [new URL('./harness.ts', import.meta.url).pathname],
  bundle: true,
  format: 'iife',
  target: 'es2020',
  loader: { '.wasm': 'binary' },
  logOverride: { 'empty-import-meta': 'silent' },
  write: false,
});
const script = outputFiles[0].text;

let failed = false;
for (const name of requested) {
  const engine = engines[name];
  if (!engine) throw new Error(`unknown browser ${name}`);
  const browser = await engine.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><html><body></body></html>');
    await page.addScriptTag({ content: script });
    const report = await page.evaluate(() => window.smoke());
    console.log(`\n${name}: ${report.userAgent}`);
    console.log(`  preferred encoder: ${report.preferred}; canvas toBlob('image/webp') -> ${report.canvasType}`);
    for (const v of report.variants) {
      console.log(`  ${v.variant}: ${v.bytes} B in ${v.ms} ms, round trip ${v.roundTrip ? 'ok' : 'FAILED'}`);
      failed ||= !v.roundTrip || v.bytes === 0;
    }
  } catch (error) {
    console.error(`${name}: ${error.stack ?? error}`);
    failed = true;
  } finally {
    await browser.close();
  }
}
process.exit(failed ? 1 : 0);
