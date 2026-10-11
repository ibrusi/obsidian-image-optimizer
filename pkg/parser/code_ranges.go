package parser

import (
	"sort"
	"strings"
)

// span is a half-open byte range [start, end) of the document.
type span struct{ start, end int }

// codeRanges returns the sorted, non-overlapping byte ranges whose content is
// not rendered as regular markdown: fenced code blocks (``` and ~~~), inline
// code spans, HTML comments (<!-- -->) and Obsidian comments (%% %%).
// Image links inside these ranges are examples or disabled content and must
// never be downloaded or rewritten.
//
// Indented (4-space) code blocks are intentionally not detected: in Obsidian
// notes the same indentation is far more often a nested list item, and
// skipping real images there would be a worse failure than processing an
// indented example.
func codeRanges(content string) []span {
	fences := fencedBlocks(content)

	ranges := make([]span, 0, len(fences))
	pos := 0
	for _, f := range fences {
		ranges = append(ranges, inlineRanges(content, pos, f.start)...)
		ranges = append(ranges, f)
		pos = f.end
	}
	ranges = append(ranges, inlineRanges(content, pos, len(content))...)
	return ranges
}

// inCode reports whether the byte offset pos lies inside one of the ranges.
func inCode(pos int, ranges []span) bool {
	i := sort.Search(len(ranges), func(i int) bool { return ranges[i].end > pos })
	return i < len(ranges) && ranges[i].start <= pos
}

// fencedBlocks finds fenced code blocks line by line, following CommonMark:
// an opening fence is 3+ backticks or tildes indented by at most 3 spaces;
// the block ends at a fence of the same character that is at least as long,
// or at the end of the document.
func fencedBlocks(content string) []span {
	var blocks []span
	var (
		inFence   bool
		fenceChar byte
		fenceLen  int
		start     int
	)

	for lineStart := 0; lineStart < len(content); {
		lineEnd := strings.IndexByte(content[lineStart:], '\n')
		if lineEnd < 0 {
			lineEnd = len(content)
		} else {
			lineEnd += lineStart + 1
		}
		line := strings.TrimRight(content[lineStart:lineEnd], "\r\n")

		char, n, rest, ok := parseFence(line)
		switch {
		case !inFence && ok && !(char == '`' && strings.ContainsRune(rest, '`')):
			inFence, fenceChar, fenceLen, start = true, char, n, lineStart
		case inFence && ok && char == fenceChar && n >= fenceLen && strings.TrimSpace(rest) == "":
			blocks = append(blocks, span{start, lineEnd})
			inFence = false
		}
		lineStart = lineEnd
	}

	if inFence {
		blocks = append(blocks, span{start, len(content)})
	}
	return blocks
}

// parseFence reports whether line starts with a code fence and returns the
// fence character, its length and the text after it.
func parseFence(line string) (char byte, n int, rest string, ok bool) {
	indent := 0
	for indent < len(line) && line[indent] == ' ' {
		indent++
	}
	if indent > 3 || indent >= len(line) {
		return 0, 0, "", false
	}
	char = line[indent]
	if char != '`' && char != '~' {
		return 0, 0, "", false
	}
	n = runLength(line, indent, char)
	if n < 3 {
		return 0, 0, "", false
	}
	return char, n, line[indent+n:], true
}

// inlineRanges finds inline code spans and comments in content[from:to].
func inlineRanges(content string, from, to int) []span {
	var ranges []span
	for i := from; i < to; {
		switch {
		case content[i] == '\\':
			i += 2 // an escaped character never opens anything
		case content[i] == '`':
			n := runLength(content[:to], i, '`')
			if end, ok := closingBackticks(content[:to], i+n, n); ok {
				ranges = append(ranges, span{i, end})
				i = end
			} else {
				i += n // an unmatched run is literal text
			}
		case strings.HasPrefix(content[i:to], "<!--"):
			end := closingMarker(content[:to], i+4, "-->")
			ranges = append(ranges, span{i, end})
			i = end
		case strings.HasPrefix(content[i:to], "%%"):
			end := closingMarker(content[:to], i+2, "%%")
			ranges = append(ranges, span{i, end})
			i = end
		default:
			i++
		}
	}
	return ranges
}

// closingBackticks finds a run of exactly n backticks after pos that closes an
// inline code span. Code spans do not cross paragraph boundaries (blank lines).
func closingBackticks(s string, pos, n int) (int, bool) {
	limit := len(s)
	if blank := strings.Index(s[pos:], "\n\n"); blank >= 0 {
		limit = pos + blank
	}
	for i := pos; i < limit; {
		if s[i] != '`' {
			i++
			continue
		}
		m := runLength(s[:limit], i, '`')
		if m == n {
			return i + m, true
		}
		i += m
	}
	return 0, false
}

// closingMarker returns the end of a comment opened before pos; an unclosed
// comment extends to the end of s, as it does when rendered.
func closingMarker(s string, pos int, marker string) int {
	if idx := strings.Index(s[pos:], marker); idx >= 0 {
		return pos + idx + len(marker)
	}
	return len(s)
}

func runLength(s string, pos int, char byte) int {
	n := 0
	for pos+n < len(s) && s[pos+n] == char {
		n++
	}
	return n
}
