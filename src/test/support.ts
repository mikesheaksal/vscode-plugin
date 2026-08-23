import type { ChildProcess } from 'node:child_process';
import { rmSync } from 'node:fs';

/**
 * Kills a child process and waits for the operating system to finish with it.
 *
 * `kill` only asks: it returns long before the process is gone. Windows keeps the
 * executable's image mapped until teardown completes, so a suite that kills the
 * mock server and immediately deletes the directory holding its binary is racing
 * the kernel - which is what CI hit, as EPERM on the build directory in five
 * suites at once.
 */
export async function stopProcess(
  child: ChildProcess | undefined,
  timeoutMs = 10_000,
): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill('SIGKILL');
  await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))]);
}

/**
 * Deletes a temporary directory, tolerating a lock the test does not own.
 *
 * Windows refuses to delete a directory something is watching, and the activated
 * extension legitimately watches whichever credential directory the settings
 * point at - a test cannot reach into the extension host and dispose that
 * watcher. Housekeeping in an OS temp directory is not an assertion, so a
 * directory that will not go is reported and left for the operating system to
 * reclaim rather than failing a suite whose tests all passed.
 */
export function removeTree(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
  } catch (error) {
    console.warn(`test cleanup: could not remove ${path}: ${(error as Error).message}`);
  }
}
