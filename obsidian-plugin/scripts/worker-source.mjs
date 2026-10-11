import esbuild from 'esbuild';

// EMSCRIPTEN_WEB makes the Emscripten glue of the encoders take its browser
// code path everywhere. Obsidian on desktop exposes Node's process object,
// and in Node mode the glue loads the .wasm with require() relative to
// import.meta.url, which does not exist in the plugin bundle.
export const EMSCRIPTEN_WEB = {
  define: { process: 'undefined' },
  external: ['module'],
};

// workerSourcePlugin builds src/codec/worker.ts into a standalone script and
// exposes it as the default export of "virtual:worker-source", so the worker
// ships inside main.js and is started from a Blob URL.
export function workerSourcePlugin({ minify = true } = {}) {
  return {
    name: 'worker-source',
    setup(build) {
      build.onResolve({ filter: /^virtual:worker-source$/ }, (args) => ({ path: args.path, namespace: 'worker-source' }));
      build.onLoad({ filter: /.*/, namespace: 'worker-source' }, async () => {
        const result = await esbuild.build({
          entryPoints: [new URL('../src/codec/worker.ts', import.meta.url).pathname],
          bundle: true,
          format: 'iife',
          target: 'es2020',
          platform: 'browser',
          logOverride: { 'empty-import-meta': 'silent' },
          ...EMSCRIPTEN_WEB,
          minify,
          legalComments: 'none',
          write: false,
        });
        return { contents: `export default ${JSON.stringify(result.outputFiles[0].text)};`, loader: 'js' };
      });
    },
  };
}
