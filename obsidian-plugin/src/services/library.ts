import { dimensionsOf } from '../domain/dimensions.ts';
import { imageTypeOf, SNIFF_BYTES, type ImageType } from '../domain/sniff.ts';
import { tagOf, tagOfFingerprint, withTag } from '../domain/source-tag.ts';
import type { VaultPort } from './ports.ts';
import { sameBytes, type Stored, store } from './storage.ts';

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
// anything is encoded, on any device. After encoding, a file anywhere in the
// vault with exactly the same bytes is reused too: it catches the same
// picture arriving as a different original (a PNG re-saved by the clipboard)
// and files saved before tags existed. With reuse off, nothing is looked up
// or tagged and every image is a new file.
export class ImageLibrary {
  private readonly vault: VaultPort;
  private readonly reuse: boolean;

  constructor(vault: VaultPort, reuse: boolean) {
    this.vault = vault;
    this.reuse = reuse;
  }

  // find looks the original up. accept can refuse a file, such as the
  // original itself when converting an image that is already in the vault.
  // WebP files come first: they are what the plugin writes. A file is used
  // only once it is verified to hold this image, see holds.
  async find(original: ArrayBuffer, type: ImageType, accept: (path: string) => boolean = () => true): Promise<Found> {
    if (!this.reuse) return { tag: null, path: null };
    const tag = tagOfFingerprint(await fingerprint(original));
    const candidates = this.vault.allFiles()
      .filter((path) => tagOf(path.slice(path.lastIndexOf('/') + 1)) === tag && accept(path))
      .sort((a, b) => Number(!a.endsWith('.webp')) - Number(!b.endsWith('.webp')) || a.length - b.length || a.localeCompare(b));
    for (const path of candidates) {
      if (await this.holds(path, original, type)) return { tag, path };
    }
    return { tag, path: null };
  }

  // holds guards against a tag shared by another image: a different original
  // with the same start of its hash, or a name that merely ends in 16 digits.
  // A file in the original's own format is the original saved unconverted and
  // must match byte for byte; a WebP made from it must have its width and
  // height (swapped too for JPEG, whose EXIF rotation is applied to pixels).
  private async holds(path: string, original: ArrayBuffer, type: ImageType): Promise<boolean> {
    let data: ArrayBuffer;
    try {
      data = await this.vault.readBinary(path);
    } catch {
      return false;
    }
    const found = imageTypeOf(new Uint8Array(data, 0, Math.min(data.byteLength, SNIFF_BYTES)));
    if (found === type) return sameBytes(data, original);
    if (found !== 'webp') return false;
    const want = dimensionsOf(new Uint8Array(original), type);
    const have = dimensionsOf(new Uint8Array(data), 'webp');
    if (!want || !have) return false;
    return (want.width === have.width && want.height === have.height) ||
      (type === 'jpeg' && want.width === have.height && want.height === have.width);
  }

  // save writes data as stem-tag.ext in folder, or reuses a file in the
  // vault with exactly these bytes.
  save(tag: string | null, folder: string, stem: string, ext: string, data: ArrayBuffer): Promise<Stored> {
    return store(this.vault, folder, tag ? withTag(stem, tag) : stem, ext, data, this.reuse);
  }
}

// fingerprint returns the SHA-256 of data as hex.
export async function fingerprint(data: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}
