// RemoteImage is a Markdown embed ![alt](https://…) found in a note.
export interface RemoteImage {
  start: number; // offset of "!"
  end: number; // offset after ")"
  alt: string;
  url: string;
}

interface Range {
  start: number;
  end: number;
}

// findRemoteImages returns the Markdown embeds of http(s) images, skipping
// code blocks, inline code and comments, where links are only text.
export function findRemoteImages(text: string): RemoteImage[] {
  const skipped = ignoredRanges(text);
  const images: RemoteImage[] = [];
  let skipIndex = 0;

  for (let i = text.indexOf('![');
    i !== -1;
    i = text.indexOf('![', i + 1)) {
    while (skipIndex < skipped.length && skipped[skipIndex].end <= i) skipIndex++;
    const range = skipped[skipIndex];
    if (range && range.start <= i) {
      i = range.end - 1;
      continue;
    }
    if (i > 0 && text[i - 1] === '\\') continue;
    const image = parseEmbed(text, i);
    if (image) {
      images.push(image);
      i = image.end - 1;
    }
  }
  return images;
}

// replaceImages swaps each embed for its replacement, keyed by URL.
export function replaceImages(text: string, replacements: ReadonlyMap<string, string>): string {
  let result = '';
  let last = 0;
  for (const image of findRemoteImages(text)) {
    const replacement = replacements.get(image.url);
    if (replacement === undefined) continue;
    result += text.slice(last, image.start) + replacement;
    last = image.end;
  }
  return result + text.slice(last);
}

function parseEmbed(text: string, start: number): RemoteImage | null {
  // Alt text: up to the matching "]" on the same line, honouring escapes.
  let i = start + 2;
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
  const alt = text.slice(start + 2, i);

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
  if (!/^https?:\/\//i.test(url)) return null;
  return { start, end: i + 1, alt, url };
}

// ignoredRanges lists fenced code blocks, inline code spans, HTML comments
// and Obsidian %% comments, sorted by start.
function ignoredRanges(text: string): Range[] {
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
