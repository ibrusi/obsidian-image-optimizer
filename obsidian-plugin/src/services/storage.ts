import { joinPath } from '../domain/folders.ts';
import { availableName } from '../domain/names.ts';
import type { VaultPort } from './ports.ts';

// saveNew writes data under a free name in folder and returns its path; it
// never overwrites a file. A name taken between the check and the write (a
// sync client, another plugin) is retried with the next free name.
export async function saveNew(vault: VaultPort, folder: string, stem: string, ext: string, data: ArrayBuffer): Promise<string> {
  await vault.ensureFolder(folder);
  const attempted = new Set<string>();
  for (let attempt = 0; attempt < 3; attempt++) {
    const taken = new Set([...vault.names(folder), ...attempted]);
    const name = availableName(taken, stem, ext);
    const path = joinPath(folder, name);
    try {
      await vault.createBinary(path, data);
      return path;
    } catch (error) {
      if (!vault.exists(path)) throw error;
      attempted.add(name.toLowerCase());
    }
  }
  throw new Error(`could not find a free name for ${stem}.${ext} in "${folder || '/'}"`);
}
