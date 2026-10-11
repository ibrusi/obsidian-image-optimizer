import esbuild from 'esbuild';

const production = process.argv.includes('--production');

await esbuild.build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  format: 'cjs',
  target: 'es2020',
  // No Node APIs: the same bundle has to run in the mobile apps.
  platform: 'browser',
  external: ['obsidian'],
  // Plugins cannot fetch files next to main.js on mobile, so the WebAssembly
  // encoders are embedded into the bundle as bytes.
  loader: { '.wasm': 'binary' },
  // The Emscripten glue reads import.meta.url only to locate the .wasm file;
  // the encoder passes the compiled module and locateFile instead.
  logOverride: { 'empty-import-meta': 'silent' },
  minify: production,
  sourcemap: production ? false : 'inline',
  legalComments: 'eof',
  outfile: 'main.js',
  logLevel: 'info',
});
