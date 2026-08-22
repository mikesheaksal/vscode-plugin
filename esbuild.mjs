import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const extension = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'out/extension.js',
  // The extension host provides `vscode` at runtime; bundling it would fail.
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

/**
 * The webview script is a separate bundle: it runs in a browser context with no
 * Node and no `vscode` module. It shares src/core with the extension, which is
 * the point - the renderer and the validator cannot drift apart.
 */
/** @type {import('esbuild').BuildOptions} */
const webview = {
  entryPoints: ['src/webview/form.ts'],
  bundle: true,
  outfile: 'media/form.js',
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

if (watch) {
  for (const options of [extension, webview]) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
  }
} else {
  await Promise.all([esbuild.build(extension), esbuild.build(webview)]);
}
