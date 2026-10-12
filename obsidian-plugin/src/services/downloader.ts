import { blockedHostReason } from '../domain/policy.ts';
import { imageTypeOf, type ImageType } from '../domain/sniff.ts';
import type { HttpPort } from './ports.ts';

export const DOWNLOAD_TIMEOUT_MS = 60_000;

export interface Downloaded {
  data: ArrayBuffer;
  type: ImageType;
}

export interface DownloadOptions {
  maxBytes: number;
  allowPrivateHosts: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

// download fetches an image and accepts it only if its bytes are an image:
// hotlink protection often answers 200 with an HTML page.
export async function download(http: HttpPort, url: string, options: DownloadOptions): Promise<Downloaded> {
  const blocked = blockedHostReason(url, options.allowPrivateHosts);
  if (blocked) throw new Error(`refused: ${blocked}`);
  options.signal?.throwIfAborted();

  const response = await withTimeout(http.get(url), options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS, options.signal);
  if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}`);
  const data = response.body;
  if (data.byteLength > options.maxBytes) {
    throw new Error(`too large: ${(data.byteLength / 1048576).toFixed(1)} MB`);
  }
  const type = imageTypeOf(new Uint8Array(data, 0, Math.min(data.byteLength, 16)));
  if (!type) throw new Error('the response is not an image');
  return { data, type };
}

// withTimeout bounds a request that cannot be aborted itself: Obsidian's
// requestUrl has no timeout or cancellation, so a stalled server would block
// the queue. The late response is ignored.
function withTimeout<T>(promise: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no response in ${Math.round(ms / 1000)} s`)), ms);
    const abort = () => reject(signal?.reason ?? new DOMException('Cancelled', 'AbortError'));
    signal?.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    });
  });
}
