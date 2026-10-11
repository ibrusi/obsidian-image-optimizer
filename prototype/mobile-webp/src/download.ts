import { requestUrl } from 'obsidian';
import { imageTypeOf, type ImageType } from './sniff.ts';

export const MAX_DOWNLOAD_BYTES = 30 * 1024 * 1024;

export interface Downloaded {
  data: ArrayBuffer;
  type: ImageType;
  ms: number;
}

// download fetches an image through Obsidian's native request layer, which
// is not subject to CORS and works in the mobile apps.
export async function download(url: string): Promise<Downloaded> {
  const started = performance.now();
  const response = await requestUrl({ url, throw: false });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`HTTP ${response.status}`);
  }
  const data = response.arrayBuffer;
  if (data.byteLength > MAX_DOWNLOAD_BYTES) {
    throw new Error(`too large: ${data.byteLength} bytes`);
  }
  const type = imageTypeOf(new Uint8Array(data, 0, Math.min(data.byteLength, 16)));
  if (!type) throw new Error('the response is not an image');
  return { data, type, ms: performance.now() - started };
}
