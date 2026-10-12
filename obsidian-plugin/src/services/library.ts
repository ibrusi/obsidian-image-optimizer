import type { VaultPort } from './ports.ts';
import { fingerprint, type SourceIndex } from './source-index.ts';
import { type Stored, store } from './storage.ts';

/** Log details: found through the source index, or as identical bytes. */
export const REUSED = 'already in the vault, reused';
export const IDENTICAL = 'identical file already in the vault, reused';

export interface Found {
  /** Fingerprint of the original, to pass to save; null when reuse is off. */
  key: string | null;
  /** A file already holding this image, or null. */
  path: string | null;
}

// ImageLibrary saves images without duplicates. The same original seen
// again is found through the source index before anything is encoded; an
// identical file of the same name, saved before the index existed, is found
// by comparing bytes. With reuse off, every image is saved as a new file.
export class ImageLibrary {
  private readonly vault: VaultPort;
  private readonly index: SourceIndex;
  private readonly reuse: boolean;

  constructor(vault: VaultPort, index: SourceIndex, reuse: boolean) {
    this.vault = vault;
    this.index = index;
    this.reuse = reuse;
  }

  // find looks the original up. accept can refuse a file, such as the
  // original itself when converting an image that is already in the vault.
  async find(original: ArrayBuffer, accept: (path: string) => boolean = () => true): Promise<Found> {
    if (!this.reuse) return { key: null, path: null };
    const key = await fingerprint(original);
    const path = this.index.get(key);
    // The index can be stale: a file renamed or deleted while the plugin
    // was off, or by another device.
    if (path && this.vault.size(path) !== null && accept(path)) return { key, path };
    return { key, path: null };
  }

  async save(key: string | null, folder: string, stem: string, ext: string, data: ArrayBuffer): Promise<Stored> {
    const stored = await store(this.vault, folder, stem, ext, data, this.reuse);
    if (key) this.index.set(key, stored.path);
    return stored;
  }
}
