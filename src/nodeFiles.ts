import { readFile, stat } from 'node:fs/promises';
import type { FileReader, ReadFile } from './core/credentials';

/** Real-filesystem implementation of the FileReader port. */
export const nodeFiles: FileReader = {
  async read(path: string): Promise<ReadFile | undefined> {
    try {
      const [content, stats] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
      // Mode bits are meaningless on Windows, so we leave them off rather than
      // reporting a value the permission warning would misread.
      return process.platform === 'win32' ? { content } : { content, mode: stats.mode & 0o777 };
    } catch {
      return undefined;
    }
  },
};
