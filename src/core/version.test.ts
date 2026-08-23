import { describe, expect, it } from 'vitest';
import { compareVersions, isOutdated, parseVersion } from './version';

describe('parseVersion', () => {
  it('reads major, minor and patch', () => {
    expect(parseVersion('1.2.3')).toMatchObject({ major: 1, minor: 2, patch: 3, prerelease: '' });
  });

  it('reads a pre-release suffix', () => {
    expect(parseVersion('1.2.0-rc.1')?.prerelease).toBe('rc.1');
  });

  it('ignores build metadata', () => {
    expect(parseVersion('1.2.3+build.5')).toMatchObject({ patch: 3, prerelease: '' });
  });

  it.each(['', 'v1.2.3', '1.2', '1.2.3.4', 'latest', '1.x.0'])('rejects %o', (value) => {
    expect(parseVersion(value)).toBeUndefined();
  });
});

describe('compareVersions', () => {
  it.each([
    ['1.0.0', '1.0.0', 0],
    ['1.0.1', '1.0.0', 1],
    ['1.1.0', '1.0.9', 1],
    ['2.0.0', '1.99.99', 1],
    ['0.9.0', '0.10.0', -1],
  ] as const)('%s vs %s', (left, right, expected) => {
    expect(Math.sign(compareVersions(left, right))).toBe(expected);
  });

  it('ranks a release above its own pre-release', () => {
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBeLessThan(0);
  });

  it('orders pre-releases against each other', () => {
    expect(compareVersions('1.0.0-rc.1', '1.0.0-rc.2')).toBeLessThan(0);
  });

  it('treats an unparseable version as equal rather than older', () => {
    // Refusing to run because a version string was odd would be worse than the
    // risk it guards against.
    expect(compareVersions('nonsense', '1.0.0')).toBe(0);
  });
});

describe('isOutdated', () => {
  it('is true only when the running version is behind the minimum', () => {
    expect(isOutdated('0.1.0', '0.2.0')).toBe(true);
    expect(isOutdated('0.2.0', '0.2.0')).toBe(false);
    expect(isOutdated('0.3.0', '0.2.0')).toBe(false);
  });

  it('never locks anyone out when the server sets no minimum', () => {
    expect(isOutdated('0.1.0', '')).toBe(false);
    expect(isOutdated('0.1.0', '   ')).toBe(false);
    expect(isOutdated('0.1.0', 'unknown')).toBe(false);
  });

  it('does not act on a running version it cannot parse', () => {
    expect(isOutdated('dev', '9.9.9')).toBe(false);
  });

  it('counts a pre-release as behind the release it precedes', () => {
    expect(isOutdated('1.0.0-rc.1', '1.0.0')).toBe(true);
  });
});
