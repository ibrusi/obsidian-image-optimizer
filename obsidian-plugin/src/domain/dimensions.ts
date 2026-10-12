import type { ImageType } from './sniff.ts';

export interface Dimensions {
  width: number;
  height: number;
}

// dimensionsOf reads width and height from the image header without decoding,
// so oversized images are refused before they allocate width × height × 4
// bytes. Returns null when the header cannot be read.
export function dimensionsOf(bytes: Uint8Array, type: ImageType): Dimensions | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    switch (type) {
      case 'png': // IHDR is always the first chunk
        return { width: view.getUint32(16), height: view.getUint32(20) };
      case 'gif': // logical screen descriptor
        return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
      case 'bmp': {
        const height = view.getInt32(22, true);
        return { width: Math.abs(view.getInt32(18, true)), height: Math.abs(height) };
      }
      case 'jpeg':
        return jpegDimensions(bytes, view);
      case 'webp':
        return webpDimensions(bytes, view);
    }
  } catch {
    return null; // truncated header
  }
}

// webpDimensions reads the canvas of an extended file (VP8X, used for
// animation and metadata), or the frame of a simple lossy (VP8) or lossless
// (VP8L) one.
function webpDimensions(bytes: Uint8Array, view: DataView): Dimensions | null {
  const chunk = String.fromCharCode(...bytes.subarray(12, 16));
  switch (chunk) {
    case 'VP8X':
      return { width: 1 + (view.getUint32(24, true) & 0xffffff), height: 1 + (view.getUint32(26, true) >>> 8) };
    case 'VP8 ':
      if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
      return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
    case 'VP8L': {
      if (bytes[20] !== 0x2f) return null;
      const bits = view.getUint32(21, true);
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
    }
    default:
      return null;
  }
}

// jpegDimensions walks the marker segments up to the first start-of-frame.
function jpegDimensions(bytes: Uint8Array, view: DataView): Dimensions | null {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    if (marker === 0xff) { offset++; continue; } // fill byte
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { offset += 2; continue; }
    const length = view.getUint16(offset + 2);
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
    offset += 2 + length;
  }
  return null;
}
