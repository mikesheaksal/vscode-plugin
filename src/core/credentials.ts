/**
 * Credential resolution, free of any `vscode` import so it can be unit-tested
 * in plain Node (design §4).
 *
 * Two separate things live here, and conflating them is the mistake to avoid:
 * the **client id** says which machine this is and is what the server routes
 * alerts to; the **token** proves the caller may act as it.
 */

export type TokenSource = 'settings' | 'secretStorage' | 'file';
export type ClientIdSource = 'file' | 'credentialsFile';

/** Minimal filesystem port, so tests never touch a real disk. */
export interface FileReader {
  /** Resolves undefined when the file does not exist or cannot be read. */
  read(path: string): Promise<ReadFile | undefined>;
}

export interface ReadFile {
  content: string;
  /** POSIX mode bits, or undefined on platforms without them. */
  mode?: number | undefined;
}

export interface PathEnvironment {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  homedir: string;
}

export interface TokenResolution {
  token: string;
  source: TokenSource;
  /** Set when the file the token came from is readable by group or others. */
  insecureFilePath?: string;
}

export interface ClientIdResolution {
  clientId: string;
  source: ClientIdSource;
}

/**
 * Where a credential file lives when the user has not overridden the path.
 * `$XDG_CONFIG_HOME` wins over `~/.config` on POSIX; Windows uses `%APPDATA%`.
 */
export function defaultCredentialPath(name: string, environment: PathEnvironment): string {
  const { platform, env, homedir } = environment;
  if (platform === 'win32') {
    const base = env.APPDATA ?? join(homedir, 'AppData', 'Roaming');
    return join(base, 'acme-alerts', name);
  }
  const base = env.XDG_CONFIG_HOME ?? join(homedir, '.config');
  return join(base, 'acme-alerts', name);
}

/**
 * A credential file is either a bare value on its first line, or JSON carrying
 * `client_id` and/or `token`. Supporting both means one file can be provisioned
 * instead of two, which is a better operator story, and costs almost nothing.
 */
export function parseCredentialFile(content: string): {
  token?: string | undefined;
  clientId?: string | undefined;
  isJson: boolean;
} {
  const trimmed = content.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === 'object') {
        const record = parsed as Record<string, unknown>;
        return {
          token: stringOrUndefined(record.token),
          clientId: stringOrUndefined(record.client_id ?? record.clientId),
          isJson: true,
        };
      }
    } catch {
      // Falls through to the plain-text reading below. A file that starts with
      // "{" but does not parse is far more likely to be broken JSON than a
      // token that happens to begin with a brace, but treating it as a value
      // costs nothing and avoids a hard failure.
    }
  }
  const firstLine = trimmed.split(/\r?\n/, 1)[0]?.trim() ?? '';
  return { token: firstLine || undefined, clientId: firstLine || undefined, isJson: false };
}

/**
 * Token resolution order (design §6.1):
 *   1. the `acmeAlerts.apiToken` setting, when non-empty
 *   2. secret storage
 *   3. the token file
 *
 * The setting comes first because that is what the user most recently typed
 * somewhere visible; the migration in ConfigService then moves it into secret
 * storage so the ordering stops mattering.
 */
export async function resolveToken(options: {
  settingValue: string;
  secretValue: string | undefined;
  tokenFilePath: string;
  files: FileReader;
}): Promise<TokenResolution | undefined> {
  const fromSetting = options.settingValue.trim();
  if (fromSetting !== '') {
    return { token: fromSetting, source: 'settings' };
  }

  const fromSecret = options.secretValue?.trim();
  if (fromSecret) {
    return { token: fromSecret, source: 'secretStorage' };
  }

  const file = await options.files.read(options.tokenFilePath);
  if (!file) {
    return undefined;
  }
  const token = parseCredentialFile(file.content).token;
  if (!token) {
    return undefined;
  }
  const resolution: TokenResolution = { token, source: 'file' };
  if (isGroupOrWorldReadable(file.mode)) {
    resolution.insecureFilePath = options.tokenFilePath;
  }
  return resolution;
}

/**
 * The client id is never generated (design §6.0): an id the server has never
 * heard of routes nothing, and the user sees an extension that silently does
 * nothing. Absent means unconfigured, which the UI reports with the path it
 * looked in.
 *
 * The token file is consulted as a fallback because a combined credentials file
 * legitimately carries both values.
 */
export async function resolveClientId(options: {
  clientIdFilePath: string;
  tokenFilePath: string;
  files: FileReader;
}): Promise<ClientIdResolution | undefined> {
  const primary = await options.files.read(options.clientIdFilePath);
  if (primary) {
    const clientId = parseCredentialFile(primary.content).clientId;
    if (clientId) {
      return { clientId, source: 'file' };
    }
  }

  if (options.tokenFilePath !== options.clientIdFilePath) {
    const combined = await options.files.read(options.tokenFilePath);
    if (combined) {
      const parsed = parseCredentialFile(combined.content);
      // Only a JSON file may supply the client id here. A plain token file's
      // single line is a token, and reading it as an id would produce a
      // confident, wrong value.
      if (parsed.isJson && parsed.clientId) {
        return { clientId: parsed.clientId, source: 'credentialsFile' };
      }
    }
  }

  return undefined;
}

/** True when a POSIX mode grants read to group or others. */
export function isGroupOrWorldReadable(mode: number | undefined): boolean {
  if (mode === undefined) {
    return false;
  }
  return (mode & 0o044) !== 0;
}

function stringOrUndefined(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function join(...parts: string[]): string {
  // Deliberately not node:path — this module is pure so the tests can drive it
  // with both platforms' conventions without mocking the module registry.
  const separator = parts[0]?.includes('\\') || /^[A-Za-z]:/.test(parts[0] ?? '') ? '\\' : '/';
  return parts.join(separator);
}
