import esbuild from 'esbuild';

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
          minify,
          legalComments: 'none',
          write: false,
        });
        return { contents: `export default ${JSON.stringify(result.outputFiles[0].text)};`, loader: 'js' };
      });
    },
  };
}
