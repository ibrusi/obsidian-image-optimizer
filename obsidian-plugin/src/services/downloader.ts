import { blockedHostReason } from '../domain/policy.ts';
import { IMAGE_ACCEPT, originalUrlsFor } from '../domain/request.ts';
import { imageTypeOf, SNIFF_BYTES, type ImageType } from '../domain/sniff.ts';
import type { HttpPort, HttpResponse } from './ports.ts';

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
  /** Accept a PDF document as well as an image. */
  allowPdf?: boolean;
}

// DownloadError is a failed download with every request it took, for the
// log: the status alone (a 403) does not tell hotlink protection from a
// firewall or a blocked client.
export class DownloadError extends Error {
  readonly details: readonly string[];
  /**
   * True when asking again cannot help: the server said the file is not
   * there or not allowed (4xx), or sent something that is not an image.
   * Timeouts, network errors, 5xx, 408 and 429 are worth another try.
   */
  readonly permanent: boolean;

  constructor(message: string, details: readonly string[], permanent: boolean) {
    super(message);
    this.details = details;
    this.permanent = permanent;
  }
}

// download fetches an image the way a browser showing the page would, and
// accepts it only if its bytes are an image: hotlink protection often answers
// 200 with an HTML page. A .webp the site does not serve is looked for in its
// original format next to it. "Not there" is a 404, or a 403 from storage
// such as Amazon S3 or MinIO, which answers AccessDenied instead of 404 for a
// missing file when listing is not allowed (static.xakep.ru does so).
export async function download(http: HttpPort, url: string, options: DownloadOptions): Promise<Downloaded> {
  const attempts: string[] = [];
  try {
    return await downloadOne(http, url, options, attempts);
  } catch (error) {
    if (options.signal?.aborted) throw error;
    if (error instanceof HttpError && (error.status === 404 || error.status === 403)) {
      for (const original of originalUrlsFor(url)) {
        try {
          return await downloadOne(http, original, options, attempts);
        } catch {
          // Not there either: the original error says what went wrong.
          options.signal?.throwIfAborted();
        }
      }
    }
    throw new DownloadError(error instanceof Error ? error.message : String(error), attempts, isPermanent(error));
  }
}

// isPermanent tells a refusal that will not change during a run from a
// passing network or server trouble.
function isPermanent(error: unknown): boolean {
  if (error instanceof HttpError) return error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429;
  return error instanceof ContentError;
}

/** The response came but is not usable: not an image, too large, or refused by the host policy. */
class ContentError extends Error {}

class HttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

async function downloadOne(http: HttpPort, url: string, options: DownloadOptions, attempts: string[]): Promise<Downloaded> {
  const blocked = blockedHostReason(url, options.allowPrivateHosts);
  if (blocked) throw new ContentError(`refused: ${blocked}`);
  options.signal?.throwIfAborted();

  const response = await request(http, url, options, attempts);
  if (response.status < 200 || response.status >= 300) throw new HttpError(response.status);
  const data = response.body;
  if (data.byteLength > options.maxBytes) {
    throw new ContentError(`too large: ${(data.byteLength / 1048576).toFixed(1)} MB`);
  }
  const type = imageTypeOf(new Uint8Array(data, 0, Math.min(data.byteLength, SNIFF_BYTES)));
  if (!type || (type === 'pdf' && !options.allowPdf)) {
    throw new ContentError(options.allowPdf ? 'the response is neither an image nor a PDF' : 'the response is not an image');
  }
  return { data, type, url };
}

/** HTTP clients that refused a Referer once: later requests go without it. */
const refusesReferer = new WeakSet<HttpPort>();

// request sends the browser's headers. If the request fails without an
// answer, it is sent once more without the Referer: Obsidian on desktop
// refuses every request carrying one (net::ERR_BLOCKED_BY_CLIENT), so after
// the first refusal the Referer is no longer tried with that client.
async function request(http: HttpPort, url: string, options: DownloadOptions, attempts: string[]): Promise<HttpResponse> {
  const send = async (referer: string | undefined) => {
    const headers: Record<string, string> = { Accept: IMAGE_ACCEPT };
    if (referer) headers.Referer = referer;
    const started = Date.now();
    try {
      const response = await withTimeout(http.get(url, headers), options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS, options.signal);
      attempts.push(describeResponse(url, referer, response, Date.now() - started));
      return response;
    } catch (error) {
      if (!options.signal?.aborted) attempts.push(describeFailure(url, referer, error, Date.now() - started));
      throw error;
    }
  };
  if (!options.referer || refusesReferer.has(http)) return send(undefined);
  try {
    return await send(options.referer);
  } catch (error) {
    if (options.signal?.aborted || isTimeout(error)) throw error;
    refusesReferer.add(http);
    return send(undefined);
  }
}

/** Response headers that tell who answered and why; cookies are left out. */
const LOGGED_HEADERS = ['content-type', 'content-length', 'server', 'location', 'via', 'x-cache', 'cf-ray', 'cf-cache-status', 'x-served-by'];
const BODY_PREVIEW = 160;

// describeResponse writes one request for the log: what was sent and what
// came back, with the start of a text body (an error page usually names the
// reason).
export function describeResponse(url: string, referer: string | undefined, response: HttpResponse, ms: number): string {
  const parts = [`GET ${url} (${referer ? `Referer ${referer}` : 'no Referer'}) → ${response.status} in ${ms} ms`];
  const headers = response.headers ?? {};
  for (const name of LOGGED_HEADERS) if (headers[name]) parts.push(`${name}: ${headers[name]}`);
  parts.push(`${response.body.byteLength} bytes`);
  const preview = textPreview(response.body);
  if (preview) parts.push(`body: "${preview}"`);
  return parts.join('; ');
}

function describeFailure(url: string, referer: string | undefined, error: unknown, ms: number): string {
  const reason = error instanceof Error ? error.message : String(error);
  return `GET ${url} (${referer ? `Referer ${referer}` : 'no Referer'}) → ${reason} after ${ms} ms`;
}

// textPreview returns the start of a body that is not an image, on one line.
function textPreview(body: ArrayBuffer): string {
  const head = new Uint8Array(body, 0, Math.min(body.byteLength, 2048));
  if (head.length === 0 || imageTypeOf(head.subarray(0, SNIFF_BYTES))) return '';
  const text = new TextDecoder('utf-8', { fatal: false }).decode(head)
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\u0000-\u001f`"]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > BODY_PREVIEW ? `${text.slice(0, BODY_PREVIEW)}…` : text;
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
