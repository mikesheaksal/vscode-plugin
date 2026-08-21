import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'out/src/test/**/*.itest.js',
  version: 'stable',
  mocha: { timeout: 30_000 },
});
