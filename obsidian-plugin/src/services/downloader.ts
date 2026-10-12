import { blockedHostReason } from '../domain/policy.ts';
import { IMAGE_ACCEPT, originalUrlsFor } from '../domain/request.ts';
import { imageTypeOf, type ImageType } from '../domain/sniff.ts';
import type { HttpPort } from './ports.ts';

export const DOWNLOAD_TIMEOUT_MS = 60_000;

export interface Downloaded {
  data: ArrayBuffer;
  type: ImageType;
  /** The URL the image came from: the original when a missing .webp was replaced by it. */
  url: string;
}

export interface DownloadOptions {
  maxBytes: number;
  allowPrivateHosts: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** The page showing the image, for sites that refuse images to other pages. */
  referer?: string;
}

// download fetches an image the way a browser showing the page would, and
// accepts it only if its bytes are an image: hotlink protection often answers
// 200 with an HTML page. A .webp the site no longer serves (404) is looked
// for in its original format next to it.
export async function download(http: HttpPort, url: string, options: DownloadOptions): Promise<Downloaded> {
  try {
    return await downloadOne(http, url, options);
  } catch (error) {
    if (!(error instanceof HttpError) || error.status !== 404) throw error;
    for (const original of originalUrlsFor(url)) {
      try {
        return await downloadOne(http, original, options);
      } catch {
        // Not there either: the original error says what went wrong.
        options.signal?.throwIfAborted();
      }
    }
    throw error;
  }
}

class HttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

async function downloadOne(http: HttpPort, url: string, options: DownloadOptions): Promise<Downloaded> {
  const blocked = blockedHostReason(url, options.allowPrivateHosts);
  if (blocked) throw new Error(`refused: ${blocked}`);
  options.signal?.throwIfAborted();

  const response = await request(http, url, options);
  if (response.status < 200 || response.status >= 300) throw new HttpError(response.status);
  const data = response.body;
  if (data.byteLength > options.maxBytes) {
    throw new Error(`too large: ${(data.byteLength / 1048576).toFixed(1)} MB`);
  }
  const type = imageTypeOf(new Uint8Array(data, 0, Math.min(data.byteLength, 16)));
  if (!type) throw new Error('the response is not an image');
  return { data, type, url };
}

// request sends the browser's headers. If the request fails without an
// answer (Obsidian on desktop answers net::ERR_BLOCKED_BY_CLIENT to some
// requests carrying a Referer), it is sent once more without the Referer.
async function request(http: HttpPort, url: string, options: DownloadOptions) {
  const send = (headers: Record<string, string>) =>
    withTimeout(http.get(url, headers), options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS, options.signal);
  if (!options.referer) return send({ Accept: IMAGE_ACCEPT });
  try {
    return await send({ Accept: IMAGE_ACCEPT, Referer: options.referer });
  } catch (error) {
    if (options.signal?.aborted || isTimeout(error)) throw error;
    return send({ Accept: IMAGE_ACCEPT });
  }
}

class TimeoutError extends Error {}

function isTimeout(error: unknown): boolean {
  return error instanceof TimeoutError;
}

// withTimeout bounds a request that cannot be aborted itself: Obsidian's
// requestUrl has no timeout or cancellation, so a stalled server would block
// the queue. The late response is ignored.
function withTimeout<T>(promise: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(`no response in ${Math.round(ms / 1000)} s`)), ms);
    const abort = () => reject(signal?.reason ?? new DOMException('Cancelled', 'AbortError'));
    signal?.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    });
  });
}
