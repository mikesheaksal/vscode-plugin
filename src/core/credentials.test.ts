import { describe, expect, it } from 'vitest';
import {
  defaultCredentialPath,
  isGroupOrWorldReadable,
  parseCredentialFile,
  resolveClientId,
  resolveToken,
  type FileReader,
  type ReadFile,
} from './credentials';

function files(entries: Record<string, ReadFile>): FileReader {
  return { read: async (path) => entries[path] };
}

describe('defaultCredentialPath', () => {
  it('prefers XDG_CONFIG_HOME on POSIX', () => {
    expect(
      defaultCredentialPath('token', {
        platform: 'linux',
        env: { XDG_CONFIG_HOME: '/xdg' },
        homedir: '/home/u',
      }),
    ).toBe('/xdg/acme-alerts/token');
  });

  it('falls back to ~/.config on POSIX', () => {
    expect(
      defaultCredentialPath('client-id', { platform: 'linux', env: {}, homedir: '/home/u' }),
    ).toBe('/home/u/.config/acme-alerts/client-id');
  });

  it('uses APPDATA on Windows', () => {
    expect(
      defaultCredentialPath('token', {
        platform: 'win32',
        env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' },
        homedir: 'C:\\Users\\u',
      }),
    ).toBe('C:\\Users\\u\\AppData\\Roaming\\acme-alerts\\token');
  });
});

describe('parseCredentialFile', () => {
  it('reads a bare token from the first line', () => {
    expect(parseCredentialFile('  tok-123  \nignored\n')).toEqual({
      token: 'tok-123',
      clientId: 'tok-123',
      isJson: false,
    });
  });

  it('reads both values from a combined JSON file', () => {
    const parsed = parseCredentialFile('{"client_id":"dev-9","token":"tok-123"}');
    expect(parsed).toEqual({ token: 'tok-123', clientId: 'dev-9', isJson: true });
  });

  it('accepts camelCase clientId too', () => {
    expect(parseCredentialFile('{"clientId":"dev-9"}').clientId).toBe('dev-9');
  });

  it('treats unparseable JSON-looking content as a plain value rather than failing', () => {
    const parsed = parseCredentialFile('{not json');
    expect(parsed.isJson).toBe(false);
    expect(parsed.token).toBe('{not json');
  });

  it('returns undefined for an empty file', () => {
    expect(parseCredentialFile('  \n  ').token).toBeUndefined();
  });
});

describe('resolveToken', () => {
  const tokenFilePath = '/cfg/token';
  const base = { tokenFilePath, files: files({ [tokenFilePath]: { content: 'from-file' } }) };

  it('prefers the setting over everything else', async () => {
    const result = await resolveToken({ ...base, settingValue: 'from-setting', secretValue: 'from-secret' });
    expect(result).toEqual({ token: 'from-setting', source: 'settings' });
  });

  it('prefers secret storage over the file', async () => {
    const result = await resolveToken({ ...base, settingValue: '  ', secretValue: 'from-secret' });
    expect(result).toEqual({ token: 'from-secret', source: 'secretStorage' });
  });

  it('falls back to the file', async () => {
    const result = await resolveToken({ ...base, settingValue: '', secretValue: undefined });
    expect(result).toEqual({ token: 'from-file', source: 'file' });
  });

  it('treats a whitespace-only setting as absent', async () => {
    const result = await resolveToken({ ...base, settingValue: '   ', secretValue: undefined });
    expect(result?.source).toBe('file');
  });

  it('resolves to undefined when no source has a token', async () => {
    const result = await resolveToken({
      settingValue: '',
      secretValue: undefined,
      tokenFilePath,
      files: files({}),
    });
    expect(result).toBeUndefined();
  });

  it('flags a token file readable by group or others', async () => {
    const result = await resolveToken({
      settingValue: '',
      secretValue: undefined,
      tokenFilePath,
      files: files({ [tokenFilePath]: { content: 'from-file', mode: 0o644 } }),
    });
    expect(result?.insecureFilePath).toBe(tokenFilePath);
  });

  it('does not flag a token file readable only by its owner', async () => {
    const result = await resolveToken({
      settingValue: '',
      secretValue: undefined,
      tokenFilePath,
      files: files({ [tokenFilePath]: { content: 'from-file', mode: 0o600 } }),
    });
    expect(result?.insecureFilePath).toBeUndefined();
  });

  it('re-reads its sources on every call, so invalidation after a 401 picks up a rotated token', async () => {
    let content = 'old-token';
    const reader: FileReader = { read: async () => ({ content }) };
    const first = await resolveToken({
      settingValue: '',
      secretValue: undefined,
      tokenFilePath,
      files: reader,
    });
    content = 'rotated-token';
    const second = await resolveToken({
      settingValue: '',
      secretValue: undefined,
      tokenFilePath,
      files: reader,
    });
    expect(first?.token).toBe('old-token');
    expect(second?.token).toBe('rotated-token');
  });
});

describe('resolveClientId', () => {
  it('reads the client-id file', async () => {
    const result = await resolveClientId({
      clientIdFilePath: '/cfg/client-id',
      tokenFilePath: '/cfg/token',
      files: files({ '/cfg/client-id': { content: 'dev-9\n' } }),
    });
    expect(result).toEqual({ clientId: 'dev-9', source: 'file' });
  });

  it('falls back to a combined JSON credentials file', async () => {
    const result = await resolveClientId({
      clientIdFilePath: '/cfg/client-id',
      tokenFilePath: '/cfg/token',
      files: files({ '/cfg/token': { content: '{"client_id":"dev-9","token":"t"}' } }),
    });
    expect(result).toEqual({ clientId: 'dev-9', source: 'credentialsFile' });
  });

  it('never reads a plain token file as a client id', async () => {
    // The single line of a plain token file is a token. Reading it as an id
    // would produce a confident, wrong value and route nothing.
    const result = await resolveClientId({
      clientIdFilePath: '/cfg/client-id',
      tokenFilePath: '/cfg/token',
      files: files({ '/cfg/token': { content: 'tok-123' } }),
    });
    expect(result).toBeUndefined();
  });

  it('resolves to undefined rather than generating an id', async () => {
    const result = await resolveClientId({
      clientIdFilePath: '/cfg/client-id',
      tokenFilePath: '/cfg/token',
      files: files({}),
    });
    expect(result).toBeUndefined();
  });
});

describe('isGroupOrWorldReadable', () => {
  it.each([
    [0o600, false],
    [0o400, false],
    [0o640, true],
    [0o604, true],
    [0o644, true],
  ])('mode %o -> %s', (mode, expected) => {
    expect(isGroupOrWorldReadable(mode)).toBe(expected);
  });

  it('is false where the platform reports no mode', () => {
    expect(isGroupOrWorldReadable(undefined)).toBe(false);
  });
});
