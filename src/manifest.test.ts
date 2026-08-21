import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import manifest from '../package.json';

/**
 * The manifest is the half of a VS Code extension that the compiler never sees:
 * a command id typo in `menus`, a `viewsWelcome` link to a command that does
 * not exist, or a missing icon file all fail silently at runtime.
 *
 * These checks run anywhere, unlike the integration tests in src/test, which
 * need a real VS Code.
 */

const commandIds = new Set(manifest.contributes.commands.map((c) => c.command));
const viewIds = new Set(manifest.contributes.views.acmeAlerts.map((v) => v.id));

describe('manifest', () => {
  it('registers every command referenced by a menu', () => {
    for (const item of manifest.contributes.menus['view/title']) {
      expect(commandIds, `menu references unknown command ${item.command}`).toContain(
        item.command,
      );
    }
    for (const item of manifest.contributes.menus.commandPalette) {
      expect(commandIds).toContain(item.command);
    }
  });

  it('registers every command linked from a welcome view', () => {
    for (const welcome of manifest.contributes.viewsWelcome) {
      for (const [, command] of welcome.contents.matchAll(/\(command:([\w.]+)\)/g)) {
        expect(commandIds, `welcome view links unknown command ${command}`).toContain(command);
      }
      expect(viewIds).toContain(welcome.view);
    }
  });

  it('points every welcome view at a state the extension can actually set', () => {
    // StateController only produces these two. A `when` clause naming anything
    // else renders an empty view with no explanation.
    const known = new Set(['unconfigured', 'ready']);
    for (const welcome of manifest.contributes.viewsWelcome) {
      const match = /acmeAlerts\.state == '(\w+)'/.exec(welcome.when);
      expect(match, `unparsed when clause: ${welcome.when}`).not.toBeNull();
      expect(known).toContain(match?.[1]);
    }
  });

  it('ships the Activity Bar icon it declares', () => {
    for (const container of manifest.contributes.viewsContainers.activitybar) {
      expect(existsSync(container.icon), `${container.icon} is missing`).toBe(true);
    }
  });

  it('keeps every setting application-scoped', () => {
    // Workspace scope would let a token be committed in .vscode/settings.json
    // (design §6.2).
    for (const [key, value] of Object.entries(manifest.contributes.configuration.properties)) {
      expect(value.scope, `${key} should be application-scoped`).toBe('application');
    }
  });

  it('activates without blocking startup', () => {
    expect(manifest.activationEvents).toEqual(['onStartupFinished']);
  });

  it('declares the entry point the build actually produces', () => {
    expect(manifest.main).toBe('./out/extension.js');
  });
});
