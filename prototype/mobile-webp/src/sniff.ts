export type ImageType = 'jpeg' | 'png' | 'gif' | 'bmp' | 'webp';

const EXTENSIONS: Record<ImageType, string> = {
  jpeg: 'jpg',
  png: 'png',
  gif: 'gif',
  bmp: 'bmp',
  webp: 'webp',
};

// imageTypeOf identifies an image by its magic bytes. Content-Type is not
// trusted: hotlink protection often answers 200 with an HTML page.
export function imageTypeOf(bytes: Uint8Array): ImageType | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes[0] === 0x89 && ascii(1, 4) === 'PNG') return 'png';
  if (ascii(0, 4) === 'GIF8') return 'gif';
  if (ascii(0, 2) === 'BM') return 'bmp';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  return null;
}

export function extensionOf(type: ImageType): string {
  return EXTENSIONS[type];
}

// isConvertible reports whether the prototype re-encodes this type. GIFs may
// be animated and canvas decoding keeps only the first frame; WebP is final.
export function isConvertible(type: ImageType): boolean {
  return type === 'jpeg' || type === 'png' || type === 'bmp';
}
