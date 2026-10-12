// RemoteImage is a web file a note shows or links to: a Markdown embed
// ![alt](https://…), an HTML <img src="https://…"> tag, or, for PDF files
// only, a plain link [text](https://….pdf).
export interface RemoteImage {
  kind: 'markdown' | 'html';
  /** A plain link rather than an embed: rewritten as a link. */
  link: boolean;
  start: number; // offset of "!" or "<"
  end: number; // offset after ")" or ">"
  alt: string;
  url: string;
  /** Display width from <img width="…">, kept when the embed is rewritten. */
  width?: string;
}

export interface Range {
  start: number;
  end: number;
}

export interface FindOptions {
  /** Also PDF files: embeds and plain links whose URL path ends in .pdf. Off: PDFs are left alone. */
  pdf?: boolean;
}

// findRemoteImages returns the embeds of http(s) images in document order,
// and with options.pdf the embeds of and links to PDF files, skipping code
// blocks, inline code and comments, where links are only text.
export function findRemoteImages(text: string, options: FindOptions = {}): RemoteImage[] {
  const isIgnored = rangeChecker(ignoredRanges(text));
  const images: RemoteImage[] = [];

  for (let i = text.indexOf('!['); i !== -1; i = text.indexOf('![', i + 1)) {
    if (isIgnored(i) || (i > 0 && text[i - 1] === '\\')) continue;
    const image = parseEmbed(text, i);
    if (image) {
      if (!isWebEmbed(image.url) && (options.pdf || !isPdfUrl(image.url))) images.push(image);
      i = image.end - 1;
    }
  }
  if (options.pdf) {
    for (let i = text.indexOf('['); i !== -1; i = text.indexOf('[', i + 1)) {
      if (isIgnored(i) || (i > 0 && (text[i - 1] === '\\' || text[i - 1] === '!'))) continue;
      const link = parsePdfLink(text, i);
      if (link) {
        images.push(link);
        i = link.end - 1;
      }
    }
  }
  for (const match of text.matchAll(/<img\b[^>]*>/gi)) {
    if (isIgnored(match.index)) continue;
    const image = parseImgTag(match[0], match.index);
    if (image && (options.pdf || !isPdfUrl(image.url))) images.push(image);
  }

  images.sort((a, b) => a.start - b.start);
  // An <img> written inside the alt text of a Markdown embed is not an embed.
  return images.filter((image, i) => i === 0 || image.start >= images[i - 1].end);
}

// isWebEmbed tells a Markdown embed that Obsidian shows as a video or a post
// rather than an image: a YouTube video or a tweet. Downloading one only
// fetches a web page.
export function isWebEmbed(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase().replace(/^(?:www|m|mobile)\./, '');
  if (host === 'youtu.be') return true;
  if (host === 'youtube.com' || host === 'youtube-nocookie.com') return /^\/(?:watch|shorts\/|embed\/|live\/)/.test(parsed.pathname);
  if (host === 'twitter.com' || host === 'x.com') return /\/status\/\d+/.test(parsed.pathname);
  return false;
}

// replaceImages rewrites embeds: replace returns the new text for an embed,
// or undefined to keep it. Each occurrence is replaced on its own, so two
// embeds of one URL keep their own alt text and width.
export function replaceImages(text: string, replace: (image: RemoteImage) => string | undefined, options: FindOptions = {}): string {
  let result = '';
  let last = 0;
  for (const image of findRemoteImages(text, options)) {
    const replacement = replace(image);
    if (replacement === undefined) continue;
    result += text.slice(last, image.start) + replacement;
    last = image.end;
  }
  return result + text.slice(last);
}

function parseEmbed(text: string, start: number): RemoteImage | null {
  const link = parseMarkdownLink(text, start);
  if (!link || !link.embed || !/^https?:\/\//i.test(link.destination)) return null;
  return { kind: 'markdown', link: false, start, end: link.end, alt: link.text, url: link.destination };
}

// parsePdfLink parses a plain link to a web PDF. A link whose text holds an
// embed (a clickable picture) is left alone: rewriting it would drop the
// picture's own download.
function parsePdfLink(text: string, start: number): RemoteImage | null {
  const link = parseMarkdownLink(text, start);
  if (!link || link.embed || link.text.includes('![')) return null;
  if (!/^https?:\/\//i.test(link.destination) || !isPdfUrl(link.destination)) return null;
  return { kind: 'markdown', link: true, start, end: link.end, alt: link.text, url: link.destination };
}

// isPdfUrl tells a link to a PDF file by the end of its path, before any
// query or fragment: https://example.com/paper.pdf?download=1.
export function isPdfUrl(url: string): boolean {
  try {
    return /\.pdf$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

export interface MarkdownLink {
  start: number;
  end: number;
  embed: boolean;
  text: string;
  /** The destination as written, without angle brackets. */
  destination: string;
}

// parseMarkdownLink parses [text](destination "title") or its embed form
// with a leading "!" at start.
export function parseMarkdownLink(text: string, start: number): MarkdownLink | null {
  const embed = text[start] === '!';
  const open = embed ? start + 1 : start;
  if (text[open] !== '[') return null;
  // Link text: up to the matching "]" on the same line, honouring escapes.
  let i = open + 1;
  let depth = 0;
  for (; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') { i++; continue; }
    if (c === '\n') return null;
    if (c === '[') depth++;
    if (c === ']') {
      if (depth === 0) break;
      depth--;
    }
  }
  if (text[i] !== ']' || text[i + 1] !== '(') return null;
  const label = text.slice(open + 1, i);

  i += 2;
  while (text[i] === ' ') i++;
  let url: string;
  if (text[i] === '<') {
    const close = text.indexOf('>', i);
    if (close === -1 || text.slice(i, close).includes('\n')) return null;
    url = text.slice(i + 1, close);
    i = close + 1;
  } else {
    // Bare destination: parentheses must balance, e.g. wiki/File_(1).png.
    const from = i;
    let parens = 0;
    for (; i < text.length; i++) {
      const c = text[i];
      if (c === '\\') { i++; continue; }
      if (c === ' ' || c === '\n' || c === '\t') break;
      if (c === '(') parens++;
      if (c === ')') {
        if (parens === 0) break;
        parens--;
      }
    }
    url = text.slice(from, i);
  }

  // Optional title: "…", '…' or (…).
  while (text[i] === ' ') i++;
  const quote = text[i];
  if (quote === '"' || quote === "'" || quote === '(') {
    const closing = quote === '(' ? ')' : quote;
    const close = text.indexOf(closing, i + 1);
    if (close === -1) return null;
    i = close + 1;
    while (text[i] === ' ') i++;
  }
  if (text[i] !== ')') return null;
  return { start, end: i + 1, embed, text: label, destination: url };
}

// ignoredRanges lists fenced code blocks, inline code spans, HTML comments
// and Obsidian %% comments, sorted by start.
export function ignoredRanges(text: string): Range[] {
  const ranges: Range[] = [];
  // unclosed[n] is the paragraph end up to which no run of n backticks
  // exists; it keeps notes with many stray backticks linear.
  const unclosed = new Map<number, number>();
  let i = 0;
  let lineStart = true;
  while (i < text.length) {
    if (lineStart) {
      const fence = /^ {0,3}(`{3,}|~{3,})/.exec(text.slice(i, i + 64));
      if (fence) {
        const end = fenceEnd(text, i, fence[1]);
        ranges.push({ start: i, end });
        i = end;
        lineStart = true;
        continue;
      }
    }
    const c = text[i];
    if (c === '`') {
      const run = backtickRun(text, i);
      const close = findClosingRun(text, i + run, run, unclosed);
      if (close !== -1) {
        ranges.push({ start: i, end: close + run });
        i = close + run;
        lineStart = false;
        continue;
      }
      i += run;
      lineStart = false;
      continue;
    }
    if (text.startsWith('<!--', i)) {
      const close = text.indexOf('-->', i + 4);
      const end = close === -1 ? text.length : close + 3;
      ranges.push({ start: i, end });
      i = end;
      lineStart = false;
      continue;
    }
    if (text.startsWith('%%', i)) {
      const close = text.indexOf('%%', i + 2);
      const end = close === -1 ? text.length : close + 2;
      ranges.push({ start: i, end });
      i = end;
      lineStart = false;
      continue;
    }
    lineStart = c === '\n';
    i++;
  }
  return ranges;
}

// fenceEnd returns the offset after the closing fence line, or the end of
// the text for an unclosed fence (CommonMark: it runs to the end).
function fenceEnd(text: string, start: number, fence: string): number {
  const char = fence[0];
  let lineEnd = text.indexOf('\n', start);
  while (lineEnd !== -1) {
    const next = lineEnd + 1;
    let nextEnd = text.indexOf('\n', next);
    if (nextEnd === -1) nextEnd = text.length;
    const line = text.slice(next, nextEnd);
    const closing = new RegExp(`^ {0,3}\\${char}{${fence.length},}\\s*$`);
    if (closing.test(line)) return nextEnd;
    lineEnd = nextEnd === text.length ? -1 : nextEnd;
  }
  return text.length;
}

function backtickRun(text: string, start: number): number {
  let n = 0;
  while (text[start + n] === '`') n++;
  return n;
}

// findClosingRun finds a run of exactly n backticks, as CommonMark requires
// to close an inline code span. Code spans never cross a blank line.
function findClosingRun(text: string, from: number, n: number, unclosed: Map<number, number>): number {
  let limit = text.indexOf('\n\n', from);
  if (limit === -1) limit = text.length;
  if ((unclosed.get(n) ?? -1) >= limit) return -1;
  for (let i = text.indexOf('`', from); i !== -1 && i < limit; i = text.indexOf('`', i)) {
    const run = backtickRun(text, i);
    if (run === n) return i;
    i += run;
  }
  unclosed.set(n, limit);
  return -1;
}

// rangeChecker answers "is offset inside one of these sorted ranges" in
// O(log n), so notes with large code blocks stay linear overall.
export function rangeChecker(ranges: Range[]): (offset: number) => boolean {
  return (offset) => {
    let lo = 0;
    let hi = ranges.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (offset < ranges[mid].start) hi = mid - 1;
      else if (offset >= ranges[mid].end) lo = mid + 1;
      else return true;
    }
    return false;
  };
}

// parseImgTag reads src (or a lazy-loading data-src when src is a
// placeholder), alt and width from an <img> tag.
function parseImgTag(tag: string, start: number): RemoteImage | null {
  const attrs = new Map<string, string>();
  const attr = /([^\s=/>]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (const m of tag.slice(4, -1).matchAll(attr)) {
    const name = m[1].toLowerCase();
    if (!attrs.has(name)) attrs.set(name, decodeEntities(m[2] ?? m[3] ?? m[4] ?? ''));
  }
  const url = [attrs.get('src'), attrs.get('data-src'), attrs.get('data-original')]
    .map((v) => v?.trim())
    .find((v): v is string => !!v && /^https?:\/\//i.test(v));
  if (!url) return null;
  const width = attrs.get('width')?.trim();
  return {
    kind: 'html',
    link: false,
    start,
    end: start + tag.length,
    alt: attrs.get('alt') ?? '',
    url,
    ...(width && /^\d+$/.test(width) ? { width } : {}),
  };
}

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? entity;
  });
}
