import { tagOf, tagOfFingerprint, withTag } from '../domain/source-tag.ts';
import type { VaultPort } from './ports.ts';
import { type Stored, store } from './storage.ts';

/** Log details: found by its source tag, or as identical bytes. */
export const REUSED = 'already in the vault, reused';
export const IDENTICAL = 'identical file already in the vault, reused';

export interface Found {
  /** Source tag of the original, to pass to save; null when reuse is off. */
  tag: string | null;
  /** A file already holding this image, or null. */
  path: string | null;
}

// ImageLibrary saves images without duplicates. Every saved file carries
// the source tag of its original in its name (see domain/source-tag.ts), so
// the same original seen again is found among the vault's file names before
// anything is encoded, on any device. Files saved before tags existed are
// still found by comparing bytes with files of the same name. With reuse
// off, nothing is looked up or tagged and every image is a new file.
export class ImageLibrary {
  private readonly vault: VaultPort;
  private readonly reuse: boolean;

  constructor(vault: VaultPort, reuse: boolean) {
    this.vault = vault;
    this.reuse = reuse;
  }

  // find looks the original up. accept can refuse a file, such as the
  // original itself when converting an image that is already in the vault.
  // WebP files come first: they are what the plugin writes.
  async find(original: ArrayBuffer, accept: (path: string) => boolean = () => true): Promise<Found> {
    if (!this.reuse) return { tag: null, path: null };
    const tag = tagOfFingerprint(await fingerprint(original));
    const matches = this.vault.allFiles()
      .filter((path) => tagOf(path.slice(path.lastIndexOf('/') + 1)) === tag && accept(path))
      .sort((a, b) => Number(!a.endsWith('.webp')) - Number(!b.endsWith('.webp')) || a.length - b.length || a.localeCompare(b));
    return { tag, path: matches[0] ?? null };
  }

  // save writes data as stem-tag.ext in folder. A file saved before tags
  // existed, named stem.ext with exactly these bytes, is reused instead.
  save(tag: string | null, folder: string, stem: string, ext: string, data: ArrayBuffer): Promise<Stored> {
    return store(this.vault, folder, stem, ext, data, this.reuse, tag ? withTag(stem, tag) : stem);
  }
}

// fingerprint returns the SHA-256 of data as hex.
export async function fingerprint(data: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}
