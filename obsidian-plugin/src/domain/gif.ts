// GIF reading in two steps: scanGif walks the block structure without
// decompressing anything (cheap even for GIF bombs), and decodeGif turns an
// animation into full RGBA frames, composited the way browsers show them.

export interface GifInfo {
  width: number;
  height: number;
  frames: number;
}

export interface GifFrame {
  /** RGBA pixels of the whole logical screen, width × height × 4 bytes. */
  rgba: Uint8Array<ArrayBuffer>;
  durationMs: number;
}

export interface DecodedGif {
  width: number;
  height: number;
  frames: GifFrame[];
}

// Browsers show frames with a delay of 0 or 10 ms for 100 ms; animations rely on it.
const MIN_DELAY_CS = 2;
const DEFAULT_DELAY_MS = 100;

class Reader {
  offset = 0;
  private readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  byte(): number {
    if (this.offset >= this.bytes.length) throw new Error('truncated GIF');
    return this.bytes[this.offset++];
  }

  u16(): number {
    return this.byte() | (this.byte() << 8);
  }

  skip(n: number): void {
    if (this.offset + n > this.bytes.length) throw new Error('truncated GIF');
    this.offset += n;
  }

  slice(n: number): Uint8Array {
    if (this.offset + n > this.bytes.length) throw new Error('truncated GIF');
    const out = this.bytes.subarray(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }

  skipSubBlocks(): void {
    for (let size = this.byte(); size !== 0; size = this.byte()) this.skip(size);
  }

  get done(): boolean {
    return this.offset >= this.bytes.length;
  }
}

function readHeader(r: Reader): { width: number; height: number; globalTable: Uint8Array | null } {
  const signature = String.fromCharCode(...r.slice(6));
  if (signature !== 'GIF87a' && signature !== 'GIF89a') throw new Error('not a GIF');
  const width = r.u16();
  const height = r.u16();
  const flags = r.byte();
  r.skip(2); // background colour index, pixel aspect ratio
  const globalTable = flags & 0x80 ? r.slice(3 * (2 << (flags & 7))) : null;
  return { width, height, globalTable };
}

// scanGif counts frames without decompressing them. A trailing truncation
// keeps the frames read so far, as browsers do.
export function scanGif(bytes: Uint8Array): GifInfo | null {
  const r = new Reader(bytes);
  let header;
  try {
    header = readHeader(r);
  } catch {
    return null;
  }
  let frames = 0;
  try {
    while (!r.done) {
      const introducer = r.byte();
      if (introducer === 0x3b) break; // trailer
      if (introducer === 0x21) {
        r.byte(); // extension label
        r.skipSubBlocks();
      } else if (introducer === 0x2c) {
        r.skip(8);
        const flags = r.byte();
        if (flags & 0x80) r.skip(3 * (2 << (flags & 7)));
        r.byte(); // LZW minimum code size
        r.skipSubBlocks();
        frames++;
      } else {
        break; // garbage after the last frame
      }
    }
  } catch {
    // truncated: count what was complete
  }
  return { width: header.width, height: header.height, frames };
}

// decodeGif decodes every frame and composites it onto the logical screen,
// honouring transparency, local colour tables, interlacing and the disposal
// methods (keep, restore to background, restore to previous).
export function decodeGif(bytes: Uint8Array): DecodedGif {
  const r = new Reader(bytes);
  const { width, height, globalTable } = readHeader(r);
  if (width === 0 || height === 0) throw new Error('empty GIF');

  const frames: GifFrame[] = [];
  let canvas = new Uint8Array(width * height * 4); // transparent, like browsers
  let delayCs = 0;
  let transparent = -1;
  let disposal = 0;

  while (!r.done) {
    const introducer = r.byte();
    if (introducer === 0x3b) break;
    if (introducer === 0x21) {
      const label = r.byte();
      if (label === 0xf9) {
        const size = r.byte();
        const block = r.slice(size);
        disposal = (block[0] >> 2) & 7;
        delayCs = block[1] | (block[2] << 8);
        transparent = block[0] & 1 ? block[3] : -1;
        r.skipSubBlocks();
      } else {
        r.skipSubBlocks();
      }
      continue;
    }
    if (introducer !== 0x2c) break;

    const left = r.u16();
    const top = r.u16();
    const frameWidth = r.u16();
    const frameHeight = r.u16();
    const flags = r.byte();
    const table = flags & 0x80 ? r.slice(3 * (2 << (flags & 7))) : globalTable;
    const interlaced = (flags & 0x40) !== 0;
    const minCodeSize = r.byte();
    const data = readSubBlocks(r);
    if (!table) throw new Error('GIF frame without a colour table');

    const previous = disposal === 3 ? canvas.slice() : null;
    const indices = lzwDecode(data, minCodeSize, frameWidth * frameHeight);
    drawFrame(canvas, width, height, indices, table, transparent, { left, top, frameWidth, frameHeight, interlaced });

    frames.push({ rgba: canvas.slice(), durationMs: delayCs < MIN_DELAY_CS ? DEFAULT_DELAY_MS : delayCs * 10 });

    if (disposal === 2) clearRect(canvas, width, height, left, top, frameWidth, frameHeight);
    else if (disposal === 3 && previous) canvas = previous;
    // The graphic control extension applies to one frame only.
    delayCs = 0;
    transparent = -1;
    disposal = 0;
  }
  if (frames.length === 0) throw new Error('GIF without frames');
  return { width, height, frames };
}

function readSubBlocks(r: Reader): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (let size = r.byte(); size !== 0; size = r.byte()) {
    const chunk = r.slice(size);
    chunks.push(chunk);
    total += size;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

interface FrameRect {
  left: number;
  top: number;
  frameWidth: number;
  frameHeight: number;
  interlaced: boolean;
}

function drawFrame(
  canvas: Uint8Array,
  width: number,
  height: number,
  indices: Uint8Array,
  table: Uint8Array,
  transparent: number,
  rect: FrameRect,
): void {
  const colors = table.length / 3;
  const rows = rect.interlaced ? interlacedRows(rect.frameHeight) : null;
  for (let i = 0; i < rect.frameHeight; i++) {
    const y = rect.top + (rows ? rows[i] : i);
    if (y >= height) continue;
    for (let x = 0; x < rect.frameWidth; x++) {
      const px = rect.left + x;
      if (px >= width) break;
      const index = indices[i * rect.frameWidth + x];
      if (index === transparent || index >= colors) continue;
      const out = (y * width + px) * 4;
      canvas[out] = table[index * 3];
      canvas[out + 1] = table[index * 3 + 1];
      canvas[out + 2] = table[index * 3 + 2];
      canvas[out + 3] = 255;
    }
  }
}

// interlacedRows maps the n-th stored row to its row on screen: passes of
// every 8th row from 0, every 8th from 4, every 4th from 2, every 2nd from 1.
function interlacedRows(height: number): number[] {
  const rows: number[] = [];
  for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) {
    for (let y = start; y < height; y += step) rows.push(y);
  }
  return rows;
}

function clearRect(canvas: Uint8Array, width: number, height: number, left: number, top: number, w: number, h: number): void {
  for (let y = top; y < Math.min(top + h, height); y++) {
    const from = (y * width + left) * 4;
    const to = (y * width + Math.min(left + w, width)) * 4;
    if (to > from) canvas.fill(0, from, to);
  }
}

// lzwDecode decompresses GIF image data into colour indices. Output beyond
// the frame size is dropped and missing pixels stay 0, so corrupt data can
// neither overflow nor stall the decoder.
export function lzwDecode(data: Uint8Array, minCodeSize: number, pixelCount: number): Uint8Array {
  if (minCodeSize < 2 || minCodeSize > 11) throw new Error(`invalid LZW code size ${minCodeSize}`);
  const out = new Uint8Array(pixelCount);
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  const prefix = new Uint16Array(4096);
  const suffix = new Uint8Array(4096);
  const stack = new Uint8Array(4097);

  let codeSize = minCodeSize + 1;
  let codeMask = (1 << codeSize) - 1;
  let next = clear + 2;
  let previous = -1;
  let first = 0;
  let bits = 0;
  let buffer = 0;
  let written = 0;

  for (let i = 0; i < data.length && written < pixelCount;) {
    if (bits < codeSize) {
      buffer |= data[i++] << bits;
      bits += 8;
      continue;
    }
    const code = buffer & codeMask;
    buffer >>>= codeSize;
    bits -= codeSize;

    if (code === clear) {
      codeSize = minCodeSize + 1;
      codeMask = (1 << codeSize) - 1;
      next = clear + 2;
      previous = -1;
      continue;
    }
    if (code === end) break;
    if (previous === -1) {
      if (code >= clear) continue; // invalid first code: skip it
      out[written++] = code;
      previous = code;
      first = code;
      continue;
    }

    let top = 0;
    let current = code;
    if (code >= next) {
      if (code > next) break; // corrupt stream
      stack[top++] = first; // KwKwK case: the code being defined
      current = previous;
    }
    while (current >= clear) {
      stack[top++] = suffix[current];
      current = prefix[current];
    }
    first = current;
    stack[top++] = current;
    while (top > 0 && written < pixelCount) out[written++] = stack[--top];

    if (next < 4096) {
      prefix[next] = previous;
      suffix[next] = first;
      next++;
      if (next > codeMask && codeSize < 12) {
        codeSize++;
        codeMask = (1 << codeSize) - 1;
      }
    }
    previous = code;
  }
  return out;
}
