import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

const EXTENSION_ID = 'acme.acme-alerts';

/**
 * Phase 1's acceptance criterion, automated: the extension activates on its
 * own, contributes the Activity Bar container, and both views resolve.
 *
 * These run inside a real VS Code, so they catch the class of mistake that a
 * typecheck cannot — a bad `when` clause, a view id that does not match its
 * provider, a missing icon file.
 */
suite('Activation', () => {
  test('the extension is present and activates', async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `${EXTENSION_ID} should be installed in the test host`);
    await extension.activate();
    assert.equal(extension.isActive, true);
  });

  test('every contributed command is registered', async () => {
    await vscode.extensions.getExtension(EXTENSION_ID)?.activate();
    const registered = new Set(await vscode.commands.getCommands(true));
    for (const command of [
      'acmeAlerts.showMachine',
      'acmeAlerts.signIn',
      'acmeAlerts.showLog',
      'acmeAlerts.openSettings',
      'acmeAlerts.refresh',
    ]) {
      assert.ok(registered.has(command), `${command} should be registered`);
    }
  });

  test('the manifest contributes the container and both views', () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    const contributes = extension?.packageJSON.contributes;

    const containers = contributes.viewsContainers.activitybar as Array<{ id: string }>;
    assert.deepEqual(
      containers.map((c) => c.id),
      ['acmeAlerts'],
    );

    const views = contributes.views.acmeAlerts as Array<{ id: string; type?: string }>;
    assert.deepEqual(
      views.map((v) => v.id),
      ['acmeAlerts.machine', 'acmeAlerts.pending'],
    );
    assert.equal(views.find((v) => v.id === 'acmeAlerts.machine')?.type, 'webview');
  });

  test('both views open, and the machine webview resolves', async () => {
    await vscode.commands.executeCommand('acmeAlerts.pending.focus');
    await vscode.commands.executeCommand('acmeAlerts.machine.focus');
    // Reaching here without a rejection means VS Code found both view ids and
    // the webview provider answered. A view registered under a mismatched id
    // rejects at this point.
    assert.ok(true);
  });

  test('settings are contributed with application scope', () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    const props = extension?.packageJSON.contributes.configuration.properties as Record<
      string,
      { scope?: string }
    >;
    for (const key of [
      'acmeAlerts.serverUrl',
      'acmeAlerts.apiToken',
      'acmeAlerts.tokenFilePath',
      'acmeAlerts.clientIdFilePath',
    ]) {
      assert.ok(props[key], `${key} should be contributed`);
      // Application scope stops a token being committed in a workspace's
      // .vscode/settings.json (design §6.2).
      assert.equal(props[key]?.scope, 'application', `${key} should be application-scoped`);
    }
  });
});
