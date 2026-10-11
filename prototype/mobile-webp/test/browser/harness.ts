// Runs inside the browser under test: encodes a synthetic photo-like image
// with every available encoder and decodes the result back.
import { detectVariant, encodeWebp, encodeWithCanvas, type EncoderVariant } from '../../src/encoder.ts';

export interface SmokeReport {
  userAgent: string;
  preferred: EncoderVariant;
  variants: Array<{ variant: EncoderVariant; bytes: number; ms: number; roundTrip: boolean }>;
  canvasType: string;
}

function syntheticImage(width: number, height: number): ImageData {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, '#2b5876');
  gradient.addColorStop(1, '#f7b733');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
  const pixels = ctx.getImageData(0, 0, width, height);
  let seed = 42; // deterministic noise, like sensor grain
  for (let i = 0; i < pixels.data.length; i += 4) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const noise = (seed % 25) - 12;
    pixels.data[i] += noise;
    pixels.data[i + 1] += noise;
    pixels.data[i + 2] += noise;
  }
  return pixels;
}

async function decodesTo(data: Uint8Array, width: number, height: number): Promise<boolean> {
  const header = String.fromCharCode(...data.subarray(0, 4)) + String.fromCharCode(...data.subarray(8, 12));
  if (header !== 'RIFFWEBP') return false;
  const bitmap = await createImageBitmap(new Blob([data as BlobPart], { type: 'image/webp' }));
  const ok = bitmap.width === width && bitmap.height === height;
  bitmap.close();
  return ok;
}

(window as unknown as { smoke: () => Promise<SmokeReport> }).smoke = async () => {
  const pixels = syntheticImage(1200, 800);
  const preferred = await detectVariant();
  const report: SmokeReport = { userAgent: navigator.userAgent, preferred, variants: [], canvasType: '' };
  const variants: EncoderVariant[] = preferred === 'simd' ? ['simd', 'scalar'] : ['scalar'];
  for (const variant of variants) {
    const encoded = await encodeWebp(pixels, { variant });
    report.variants.push({
      variant,
      bytes: encoded.data.byteLength,
      ms: Math.round(encoded.ms),
      roundTrip: await decodesTo(encoded.data, pixels.width, pixels.height),
    });
  }
  report.canvasType = (await encodeWithCanvas(pixels)).type;
  return report;
};
