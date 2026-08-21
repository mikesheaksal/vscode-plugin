import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // src/test holds integration tests that run inside a real VS Code via
    // @vscode/test-cli. They import `vscode` for real and must not be picked
    // up by the plain-Node unit runner.
    exclude: ['node_modules/**', 'out/**', 'src/test/**'],
  },
});
