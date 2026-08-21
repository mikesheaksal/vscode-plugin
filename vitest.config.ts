import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // src/test holds integration tests that run inside a real VS Code via
    // @vscode/test-cli. They import `vscode` for real and must not be picked
    // up by the plain-Node unit runner.
    // .vscode-test holds a downloaded VS Code, whose bundled extensions ship
    // their own test files; without this, vitest tries to run them.
    exclude: ['node_modules/**', 'out/**', 'src/test/**', '.vscode-test/**'],
  },
});
