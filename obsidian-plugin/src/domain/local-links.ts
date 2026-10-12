import { ignoredRanges, parseMarkdownLink, rangeChecker } from './links.ts';

// LocalLink is a link to a vault file: [[target|alias]], ![[target|alias]],
// [text](target) or ![text](target), anywhere outside code and comments —
// including frontmatter properties such as cover: "[[photo.png]]".
export interface LocalLink {
  start: number;
  end: number;
  embed: boolean;
  /** Link path as Obsidian resolves it: no subpath, Markdown escapes decoded. */
  target: string;
  /** Wikilink alias, or Markdown link text; kept when the link is rewritten. */
  alias?: string;
}

// findLocalLinks returns links to vault files in document order. Web links
// and other schemes (mailto:, obsidian://) are not vault files.
export function findLocalLinks(text: string): LocalLink[] {
  const isIgnored = rangeChecker(ignoredRanges(text));
  const links: LocalLink[] = [];

  for (const m of text.matchAll(/(!?)\[\[([^\]\n]+?)\]\]/g)) {
    if (isIgnored(m.index)) continue;
    const [target, ...rest] = m[2].split('|');
    const path = stripSubpath(target.trim());
    if (!path) continue;
    const alias = rest.join('|');
    links.push({
      start: m.index,
      end: m.index + m[0].length,
      embed: m[1] === '!',
      target: path,
      ...(alias ? { alias } : {}),
    });
  }

  for (let i = text.indexOf('['); i !== -1; i = text.indexOf('[', i + 1)) {
    const start = i > 0 && text[i - 1] === '!' ? i - 1 : i;
    if (text[i + 1] === '[' || isIgnored(start) || (start > 0 && text[start - 1] === '\\')) continue;
    const link = parseMarkdownLink(text, start);
    if (!link || /^[a-z][a-z0-9+.-]*:/i.test(link.destination) || link.destination.startsWith('#')) continue;
    const path = stripSubpath(decodeDestination(link.destination));
    if (!path) continue;
    links.push({
      start,
      end: link.end,
      embed: link.embed,
      target: path,
      ...(link.text ? { alias: link.text } : {}),
    });
    i = link.end - 1;
  }

  links.sort((a, b) => a.start - b.start);
  return links.filter((link, i) => i === 0 || link.start >= links[i - 1].end);
}

// replaceLocalLinks rewrites the links for which replace returns new text.
export function replaceLocalLinks(text: string, replace: (link: LocalLink) => string | undefined): { text: string; count: number } {
  let result = '';
  let last = 0;
  let count = 0;
  for (const link of findLocalLinks(text)) {
    const replacement = replace(link);
    if (replacement === undefined) continue;
    result += text.slice(last, link.start) + replacement;
    last = link.end;
    count++;
  }
  return { text: result + text.slice(last), count };
}

function stripSubpath(target: string): string {
  const hash = target.indexOf('#');
  return (hash === -1 ? target : target.slice(0, hash)).trim();
}

function decodeDestination(destination: string): string {
  const unescaped = destination.replace(/\\(.)/g, '$1');
  try {
    return decodeURIComponent(unescaped);
  } catch {
    return unescaped; // a literal "%" in a file name
  }
}
