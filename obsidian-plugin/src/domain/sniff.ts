/** A file the plugin saves: images, and PDF documents when PDF downloads are on. */
export type ImageType = 'jpeg' | 'png' | 'gif' | 'bmp' | 'webp' | 'svg' | 'pdf';

/** Bytes from the start of a file that imageTypeOf needs: an SVG may open with an XML declaration and comments. */
export const SNIFF_BYTES = 1024;

const EXTENSIONS: Record<ImageType, string> = {
  jpeg: 'jpg',
  png: 'png',
  gif: 'gif',
  bmp: 'bmp',
  webp: 'webp',
  svg: 'svg',
  pdf: 'pdf',
};

// imageTypeOf identifies an image by its magic bytes, or an SVG by its root
// element, from the first SNIFF_BYTES of a file. Content-Type is not trusted:
// hotlink protection often answers 200 with an HTML page.
export function imageTypeOf(bytes: Uint8Array): ImageType | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (isSvg(bytes)) return 'svg';
  if (ascii(0, 5) === '%PDF-') return 'pdf';
  if (bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes[0] === 0x89 && ascii(1, 4) === 'PNG') return 'png';
  if (ascii(0, 4) === 'GIF8') return 'gif';
  if (ascii(0, 2) === 'BM') return 'bmp';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  return null;
}

// An SVG document: optional byte order mark, XML declaration, comments and
// doctype, then the <svg> root element. An HTML page never starts this way.
const SVG_START = /^\uFEFF?\s*(?:<\?xml[^>]*\?>\s*)?(?:(?:<!--[\s\S]*?-->|<!DOCTYPE\s+svg[^>]*>)\s*)*<svg[\s>/]/i;

function isSvg(bytes: Uint8Array): boolean {
  const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, SNIFF_BYTES));
  return SVG_START.test(head);
}

export function extensionOf(type: ImageType): string {
  return EXTENSIONS[type];
}

// isConvertible reports whether this type is re-encoded. GIFs may
// be animated and canvas decoding keeps only the first frame; WebP is final.
export function isConvertible(type: ImageType): boolean {
  return type === 'jpeg' || type === 'png' || type === 'bmp';
}
