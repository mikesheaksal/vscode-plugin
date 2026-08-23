/**
 * Version comparison for the minimum-client check.
 *
 * The extension is distributed as a `.vsix` passed around by hand, so it never
 * auto-updates and old installs stay in the field indefinitely. The server
 * reports the oldest version it will accept; this decides whether the one
 * running is behind it.
 *
 * Deliberately not a semver library: the comparison needed is major.minor.patch
 * with pre-release suffixes treated as "not newer", which is a dozen lines and
 * one fewer dependency in a bundle users install from a file.
 */

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /** Anything after a `-`, e.g. the `rc.1` of `1.2.0-rc.1`. */
  prerelease: string;
}

export function parseVersion(value: string): ParsedVersion | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    value.trim(),
  );
  if (!match) {
    return undefined;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? '',
  };
}

/** Negative when `left` is older, zero when equal, positive when newer. */
export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) {
    // An unparseable version is treated as equal rather than older: refusing to
    // run because a version string was odd would be worse than the risk.
    return 0;
  }

  for (const part of ['major', 'minor', 'patch'] as const) {
    if (a[part] !== b[part]) {
      return a[part] - b[part];
    }
  }

  if (a.prerelease === b.prerelease) {
    return 0;
  }
  // A release outranks any pre-release of the same numbers, per semver.
  if (a.prerelease === '') {
    return 1;
  }
  if (b.prerelease === '') {
    return -1;
  }
  return a.prerelease < b.prerelease ? -1 : 1;
}

/**
 * Whether the running version is older than the server's minimum.
 *
 * An empty or unparseable minimum means the server is not enforcing one, which
 * must not lock anybody out.
 */
export function isOutdated(current: string, minimum: string): boolean {
  if (minimum.trim() === '' || !parseVersion(minimum) || !parseVersion(current)) {
    return false;
  }
  return compareVersions(current, minimum) < 0;
}
