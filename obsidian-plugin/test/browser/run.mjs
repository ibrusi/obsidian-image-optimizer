// Browser tests of the WebAssembly encoders.
// Usage: node test/browser/run.mjs [chromium,webkit]
// WebKit is the engine of Obsidian on iOS, Chromium of desktop and Android.
import esbuild from 'esbuild';
import { chromium, webkit } from 'playwright';
import { EMSCRIPTEN_WEB, workerSourcePlugin } from '../../scripts/worker-source.mjs';

const engines = { chromium, webkit };
const requested = (process.argv[2] ?? process.env.PLUGIN_BROWSERS ?? 'chromium,webkit').split(',');

const { outputFiles } = await esbuild.build({
  entryPoints: [new URL('./harness.ts', import.meta.url).pathname],
  bundle: true,
  format: 'iife',
  target: 'es2020',
  loader: { '.wasm': 'binary', '.gif': 'binary' },
  logOverride: { 'empty-import-meta': 'silent' },
  ...EMSCRIPTEN_WEB,
  plugins: [workerSourcePlugin({ minify: false })],
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
    page.on('pageerror', (error) => console.error(`  page error: ${error.message}`));
    // A secure (https) origin, so APIs such as ImageDecoder are available.
    await page.route('https://plugin.test/**', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }));
    await page.goto('https://plugin.test/');
    await page.addScriptTag({ content: script });
    const report = await page.evaluate(() => window.run());
    console.log(`\n${name} (${report.variant}): ${report.userAgent}`);
    for (const c of report.checks) {
      console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
      failed ||= !c.ok;
    }
  } catch (error) {
    console.error(`${name}: ${error.stack ?? error}`);
    failed = true;
  } finally {
    await browser.close();
  }
}
process.exit(failed ? 1 : 0);
