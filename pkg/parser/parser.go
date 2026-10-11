// Package parser finds image embeds in Obsidian markdown and rewrites their
// targets. It is a pure package: it never touches the filesystem.
//
// Rewriting works on byte offsets: every replacement edits only the exact span
// of the link target, so alt texts, titles and HTML attributes are preserved
// verbatim, and content inside code blocks and comments is never modified.
package parser

import (
	"html"
	"net/url"
	"path"
	"regexp"
	"sort"
	"strings"

	"obsidian-image-optimizer/pkg/config"
	"obsidian-image-optimizer/pkg/imagekind"
)

// LinkKind is the syntax of an image embed.
type LinkKind int

const (
	// Markdown is ![alt](target "title").
	Markdown LinkKind = iota
	// HTML is <img src="target">.
	HTML
	// Wiki is ![[target|alt]].
	Wiki
)

// ImageRef is a single image embed found in a document.
type ImageRef struct {
	Kind LinkKind

	// Start and End delimit the whole embed in the document.
	Start, End int

	// TargetStart and TargetEnd delimit the target as written in the
	// document (for Markdown including the optional angle brackets).
	TargetStart, TargetEnd int

	// Target is the link target: angle brackets stripped for Markdown, HTML
	// entities decoded for <img>, surrounding spaces trimmed for wikilinks.
	// Percent-encoding is preserved; see DecodedPath.
	Target string

	// Alt is the alt text (Markdown, wikilink) if present.
	Alt string
}

var (
	// ![alt](dest "title"): dest may contain one level of balanced
	// parentheses, e.g. Wikipedia's "File:Foo_(bar).png", or be <bracketed>.
	mdImageRe = regexp.MustCompile(`!\[([^\]\n]*)\]\(\s*(<[^<>\n]*>|(?:[^\s()<>]|\([^\s()<>]*\))+)(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?\s*\)`)

	// <img ... src="..."> where src is preceded by whitespace, so that
	// data-src and similar attributes are not mistaken for src.
	htmlImgRe = regexp.MustCompile(`(?i)<img\b[^>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>`)

	// ![[target|alt]]
	wikiImageRe = regexp.MustCompile(`!\[\[([^\[\]|\n]+)(?:\|([^\[\]\n]*))?\]\]`)

	// A URI scheme such as https:, data: or obsidian: (two+ letters, so a
	// Windows drive letter is not mistaken for a scheme).
	schemeRe = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9+.\-]+:`)
)

// ExtractImages returns every image embed outside code blocks, inline code
// and comments, ordered by position.
func ExtractImages(content string) []ImageRef {
	code := codeRanges(content)
	var refs []ImageRef

	for _, m := range mdImageRe.FindAllStringSubmatchIndex(content, -1) {
		target := strings.TrimSuffix(strings.TrimPrefix(content[m[4]:m[5]], "<"), ">")
		refs = append(refs, ImageRef{
			Kind: Markdown, Start: m[0], End: m[1],
			TargetStart: m[4], TargetEnd: m[5],
			Target: target, Alt: content[m[2]:m[3]],
		})
	}

	for _, m := range htmlImgRe.FindAllStringSubmatchIndex(content, -1) {
		vs, ve := m[2], m[3]
		if vs < 0 {
			vs, ve = m[4], m[5]
		}
		refs = append(refs, ImageRef{
			Kind: HTML, Start: m[0], End: m[1],
			TargetStart: vs, TargetEnd: ve,
			Target: html.UnescapeString(content[vs:ve]),
		})
	}

	for _, m := range wikiImageRe.FindAllStringSubmatchIndex(content, -1) {
		ref := ImageRef{
			Kind: Wiki, Start: m[0], End: m[1],
			TargetStart: m[2], TargetEnd: m[3],
			Target: strings.TrimSpace(content[m[2]:m[3]]),
		}
		if m[4] >= 0 {
			ref.Alt = content[m[4]:m[5]]
		}
		refs = append(refs, ref)
	}

	sort.Slice(refs, func(i, j int) bool { return refs[i].Start < refs[j].Start })

	kept := refs[:0]
	lastEnd := -1
	for _, r := range refs {
		if r.Start < lastEnd || inCode(r.Start, code) || inCode(r.End-1, code) {
			continue
		}
		kept = append(kept, r)
		lastEnd = r.End
	}
	return kept
}

// ExtractRemoteImages returns every embed whose target is an http(s) URL.
func ExtractRemoteImages(content string) []ImageRef {
	return filterRefs(ExtractImages(content), func(r ImageRef) bool { return IsRemote(r.Target) })
}

// ExtractLocalImages returns every embed of a local raster image that can be
// optimised (JPEG, PNG, GIF, BMP, TIFF).
func ExtractLocalImages(content string) []ImageRef {
	return filterRefs(ExtractImages(content), func(r ImageRef) bool {
		return IsLocal(r.Target) && imagekind.IsCompressibleExt(r.DecodedPath())
	})
}

// IsRemote reports whether target is an http or https URL.
func IsRemote(target string) bool {
	lower := strings.ToLower(target)
	return strings.HasPrefix(lower, "http://") || strings.HasPrefix(lower, "https://")
}

// IsLocal reports whether target is a path inside the vault rather than a URL
// of any scheme (http:, data:, file:, obsidian:, ...).
func IsLocal(target string) bool {
	return target != "" && !strings.HasPrefix(target, "#") && !schemeRe.MatchString(target)
}

// DecodedPath returns the target as a slash-separated file path: wikilinks
// are used verbatim, other targets are percent-decoded when possible.
func (r ImageRef) DecodedPath() string {
	if r.Kind == Wiki {
		return r.Target
	}
	if decoded, err := url.PathUnescape(r.Target); err == nil {
		return decoded
	}
	return r.Target
}

// ReplaceRemoteLinks rewrites remote image targets found in urlToPath to the
// given local slash-separated paths. With LinkFormatWikilink, Markdown embeds
// are converted to wikilinks; HTML and wikilink embeds keep their syntax.
func ReplaceRemoteLinks(content string, urlToPath map[string]string, format config.LinkFormat) string {
	var edits []edit
	for _, ref := range ExtractRemoteImages(content) {
		newPath, ok := urlToPath[ref.Target]
		if !ok {
			continue
		}
		if format == config.LinkFormatWikilink && ref.Kind == Markdown {
			edits = append(edits, ref.asWikilink(newPath))
		} else {
			edits = append(edits, ref.retarget(newPath))
		}
	}
	return applyEdits(content, edits)
}

// ReplaceLocalLinks rewrites local image targets: keys are targets as
// returned in ImageRef.Target, values are the new targets in the same style.
func ReplaceLocalLinks(content string, targetToNew map[string]string) string {
	var edits []edit
	for _, ref := range ExtractLocalImages(content) {
		if newTarget, ok := targetToNew[ref.Target]; ok {
			edits = append(edits, ref.retarget(newTarget))
		}
	}
	return applyEdits(content, edits)
}

// ReplaceLastSegment returns target with its file name replaced by newName,
// preserving the folder part and the percent-encoding style of the original.
func ReplaceLastSegment(target, newName string) string {
	if strings.Contains(target, "%") {
		newName = url.PathEscape(newName)
	}
	dir, _ := path.Split(target)
	return dir + newName
}

// retarget replaces only the target span, keeping the rest of the embed intact.
func (r ImageRef) retarget(newTarget string) edit {
	var text string
	switch r.Kind {
	case Markdown:
		text = formatMarkdownDest(newTarget)
	case HTML:
		text = html.EscapeString(newTarget)
	default:
		text = newTarget
	}
	return edit{start: r.TargetStart, end: r.TargetEnd, text: text}
}

// asWikilink replaces the whole Markdown embed with an equivalent wikilink.
func (r ImageRef) asWikilink(newTarget string) edit {
	var sb strings.Builder
	sb.WriteString("![[")
	sb.WriteString(newTarget)
	if alt := wikiAltReplacer.Replace(strings.TrimSpace(r.Alt)); alt != "" {
		sb.WriteString("|")
		sb.WriteString(alt)
	}
	sb.WriteString("]]")
	return edit{start: r.Start, end: r.End, text: sb.String()}
}

var wikiAltReplacer = strings.NewReplacer("|", " ", "[", "(", "]", ")", "\n", " ")

// formatMarkdownDest wraps destinations containing spaces or parentheses in
// angle brackets, which CommonMark and Obsidian accept verbatim.
func formatMarkdownDest(dest string) string {
	if strings.ContainsAny(dest, " \t()") {
		return "<" + dest + ">"
	}
	return dest
}

func filterRefs(refs []ImageRef, keep func(ImageRef) bool) []ImageRef {
	out := refs[:0]
	for _, r := range refs {
		if keep(r) {
			out = append(out, r)
		}
	}
	return out
}

// edit replaces content[start:end] with text.
type edit struct {
	start, end int
	text       string
}

// applyEdits applies non-overlapping edits in a single pass.
func applyEdits(content string, edits []edit) string {
	if len(edits) == 0 {
		return content
	}
	sort.Slice(edits, func(i, j int) bool { return edits[i].start < edits[j].start })

	var sb strings.Builder
	sb.Grow(len(content))
	pos := 0
	for _, e := range edits {
		if e.start < pos {
			continue // overlapping edits cannot happen with ExtractImages; be defensive
		}
		sb.WriteString(content[pos:e.start])
		sb.WriteString(e.text)
		pos = e.end
	}
	sb.WriteString(content[pos:])
	return sb.String()
}
