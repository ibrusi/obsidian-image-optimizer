// A minimal GIF writer for tests: every case (transparency, disposal,
// interlacing, local palettes) is built exactly, so expected pixels are known.
// LZW data uses literal codes only, with a clear code before the code table
// would grow, which every decoder must accept.

export interface TestFrame {
  left?: number;
  top?: number;
  width: number;
  height: number;
  /** Colour indices, row by row in display order. */
  indices: number[];
  palette?: number[][]; // local colour table
  transparent?: number;
  disposal?: number;
  delayCs?: number;
  interlaced?: boolean;
}

export function buildGif(width: number, height: number, palette: number[][] | null, frames: TestFrame[], trailer = true): Uint8Array {
  const out: number[] = [...'GIF89a'].map((c) => c.charCodeAt(0));
  const u16 = (v: number) => out.push(v & 0xff, v >> 8);
  u16(width);
  u16(height);
  out.push(palette ? 0x80 | (tableBits(palette.length) - 1) : 0, 0, 0);
  if (palette) writeTable(out, palette);

  for (const f of frames) {
    const packed = ((f.disposal ?? 0) << 2) | (f.transparent !== undefined ? 1 : 0);
    out.push(0x21, 0xf9, 4, packed);
    u16(f.delayCs ?? 0);
    out.push(f.transparent ?? 0, 0);

    out.push(0x2c);
    u16(f.left ?? 0);
    u16(f.top ?? 0);
    u16(f.width);
    u16(f.height);
    out.push((f.palette ? 0x80 | (tableBits(f.palette.length) - 1) : 0) | (f.interlaced ? 0x40 : 0));
    if (f.palette) writeTable(out, f.palette);

    const stored = f.interlaced ? interlace(f.indices, f.width, f.height) : f.indices;
    out.push(8);
    const data = lzwLiteral(stored, 8);
    for (let i = 0; i < data.length; i += 255) {
      const chunk = data.slice(i, i + 255);
      out.push(chunk.length, ...chunk);
    }
    out.push(0);
  }
  if (trailer) out.push(0x3b);
  return Uint8Array.from(out);
}

function tableBits(colors: number): number {
  let bits = 1;
  while (1 << bits < colors) bits++;
  return bits;
}

function writeTable(out: number[], palette: number[][]): void {
  const size = 1 << tableBits(palette.length);
  for (let i = 0; i < size; i++) out.push(...(palette[i] ?? [0, 0, 0]));
}

function interlace(indices: number[], width: number, height: number): number[] {
  const rows: number[] = [];
  for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) {
    for (let y = start; y < height; y += step) rows.push(y);
  }
  return rows.flatMap((y) => indices.slice(y * width, (y + 1) * width));
}

function lzwLiteral(indices: number[], minCodeSize: number): number[] {
  const clear = 1 << minCodeSize;
  const codeSize = minCodeSize + 1;
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  const emit = (code: number) => {
    buffer |= code << bits;
    bits += codeSize;
    while (bits >= 8) {
      bytes.push(buffer & 0xff);
      buffer >>>= 8;
      bits -= 8;
    }
  };
  // After a clear the decoder adds one entry per code after the first;
  // the code size grows once next code > mask, so clear before that.
  const perRun = (1 << codeSize) - (clear + 2);
  emit(clear);
  let sinceClear = 0;
  for (const index of indices) {
    if (sinceClear === perRun) {
      emit(clear);
      sinceClear = 0;
    }
    emit(index);
    sinceClear++;
  }
  emit(clear + 1);
  if (bits > 0) bytes.push(buffer & 0xff);
  return bytes;
}
