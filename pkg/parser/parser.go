package parser

import (
	"fmt"
	"regexp"
	"strings"
)

var (
	// Markdown standard image: ![alt](https://... "optional title") or ![alt](<https://...> "title")
	// Group 1: alt text
	// Group 2: URL with possible angle brackets
	// Group 3: optional title with quotes
	mdImageRe = regexp.MustCompile(`!\[([^\]]*)\]\((<?https?://[^\s\)>]+>?)(?:\s+("[^"]*"|'[^']*'))?\)`)

	// HTML img tag: <img ... src="https://..." ...>
	htmlImgRe = regexp.MustCompile(`(?i)<img\b([^>]*?)\bsrc=["'](https?://[^"']+)["']([^>]*?)>`)

	// Obsidian wikilink remote image: ![[https://...]]
	wikiRemoteRe = regexp.MustCompile(`!\[\[(https?://[^\|\]]+)(?:\|([^\]]+))?\]\]`)
)

// RemoteImage represents an identified remote image link in markdown.
type RemoteImage struct {
	OriginalMatch string
	URL           string
	Alt           string
	Title         string
	IsHTML        bool
	IsWiki        bool
}

// ExtractRemoteImages finds all remote image links (HTTP/HTTPS) in markdown content.
func ExtractRemoteImages(content string) []RemoteImage {
	var images []RemoteImage
	seenURLs := make(map[string]bool)

	// 1. Find standard markdown images
	matches := mdImageRe.FindAllStringSubmatchIndex(content, -1)
	for _, m := range matches {
		matchStr := content[m[0]:m[1]]
		alt := content[m[2]:m[3]]
		rawURL := content[m[4]:m[5]]
		rawURL = strings.Trim(rawURL, "<>") // Strip angle brackets if present

		var title string
		if m[6] != -1 && m[7] != -1 {
			title = content[m[6]:m[7]]
		}

		images = append(images, RemoteImage{
			OriginalMatch: matchStr,
			URL:           rawURL,
			Alt:           alt,
			Title:         title,
			IsHTML:        false,
			IsWiki:        false,
		})
		seenURLs[rawURL] = true
	}

	// 2. Find HTML <img> tags
	htmlMatches := htmlImgRe.FindAllStringSubmatchIndex(content, -1)
	for _, m := range htmlMatches {
		matchStr := content[m[0]:m[1]]
		rawURL := content[m[4]:m[5]]

		images = append(images, RemoteImage{
			OriginalMatch: matchStr,
			URL:           rawURL,
			IsHTML:        true,
			IsWiki:        false,
		})
		seenURLs[rawURL] = true
	}

	// 3. Find Obsidian wikilinks with remote URLs: ![[https://...]]
	wikiMatches := wikiRemoteRe.FindAllStringSubmatchIndex(content, -1)
	for _, m := range wikiMatches {
		matchStr := content[m[0]:m[1]]
		rawURL := content[m[2]:m[3]]
		var alt string
		if m[4] != -1 && m[5] != -1 {
			alt = content[m[4]:m[5]]
		}

		images = append(images, RemoteImage{
			OriginalMatch: matchStr,
			URL:           rawURL,
			Alt:           alt,
			IsHTML:        false,
			IsWiki:        true,
		})
		seenURLs[rawURL] = true
	}

	return images
}

// ReplaceRemoteLinks replaces all occurrences of remote URLs with local relative paths.
func ReplaceRemoteLinks(content string, urlToRelPath map[string]string, linkFormat string) string {
	// Replace standard Markdown images
	content = mdImageRe.ReplaceAllStringFunc(content, func(match string) string {
		sub := mdImageRe.FindStringSubmatch(match)
		if len(sub) < 3 {
			return match
		}
		alt := sub[1]
		rawURL := strings.Trim(sub[2], "<>")
		title := ""
		if len(sub) > 3 && sub[3] != "" {
			title = " " + sub[3]
		}

		localPath, ok := urlToRelPath[rawURL]
		if !ok {
			return match
		}

		if linkFormat == "wikilink" {
			if alt != "" {
				return fmt.Sprintf("![[%s|%s]]", localPath, alt)
			}
			return fmt.Sprintf("![[%s]]", localPath)
		}

		return fmt.Sprintf("![%s](%s%s)", alt, localPath, title)
	})

	// Replace HTML <img> tags
	content = htmlImgRe.ReplaceAllStringFunc(content, func(match string) string {
		sub := htmlImgRe.FindStringSubmatch(match)
		if len(sub) < 4 {
			return match
		}
		prefix := strings.TrimSpace(sub[1])
		rawURL := sub[2]
		suffix := strings.TrimSpace(sub[3])

		localPath, ok := urlToRelPath[rawURL]
		if !ok {
			return match
		}

		var sb strings.Builder
		sb.WriteString("<img")
		if prefix != "" {
			sb.WriteString(" ")
			sb.WriteString(prefix)
		}
		sb.WriteString(fmt.Sprintf(" src=\"%s\"", localPath))
		if suffix != "" {
			sb.WriteString(" ")
			sb.WriteString(suffix)
		}
		sb.WriteString(">")
		return sb.String()
	})

	// Replace Wiki remote links
	content = wikiRemoteRe.ReplaceAllStringFunc(content, func(match string) string {
		sub := wikiRemoteRe.FindStringSubmatch(match)
		if len(sub) < 2 {
			return match
		}
		rawURL := sub[1]
		alt := ""
		if len(sub) > 2 && sub[2] != "" {
			alt = "|" + sub[2]
		}

		localPath, ok := urlToRelPath[rawURL]
		if !ok {
			return match
		}

		return fmt.Sprintf("![[%s%s]]", localPath, alt)
	})

	return content
}

var (
	mdLocalImageRe   = regexp.MustCompile(`!\[([^\]]*)\]\((<?([^:\s\)>]+?\.(?i:jpe?g|png|gif|bmp|tiff))>?)(?:\s+("[^"]*"|'[^']*'))?\)`)
	htmlLocalImgRe   = regexp.MustCompile(`(?i)<img\b([^>]*?)\bsrc=["']([^:\s"']+?\.(?i:jpe?g|png|gif|bmp|tiff))["']([^>]*?)>`)
	wikiLocalImageRe = regexp.MustCompile(`!\[\[([^:\|\]]+?\.(?i:jpe?g|png|gif|bmp|tiff))(?:\|([^\]]+))?\]\]`)
)

// LocalImage represents an existing local image in markdown.
type LocalImage struct {
	OriginalMatch string
	Path          string
	Alt           string
	Title         string
	IsHTML        bool
	IsWiki        bool
}

// ExtractLocalImages finds all local image paths with compressible extensions in markdown.
func ExtractLocalImages(content string) []LocalImage {
	var images []LocalImage
	seen := make(map[string]bool)

	// Markdown images
	for _, m := range mdLocalImageRe.FindAllStringSubmatchIndex(content, -1) {
		matchStr := content[m[0]:m[1]]
		alt := content[m[2]:m[3]]
		rawPath := strings.Trim(content[m[4]:m[5]], "<>")
		var title string
		if m[6] != -1 && m[7] != -1 {
			title = content[m[6]:m[7]]
		}
		if !seen[rawPath] {
			seen[rawPath] = true
			images = append(images, LocalImage{
				OriginalMatch: matchStr,
				Path:          rawPath,
				Alt:           alt,
				Title:         title,
			})
		}
	}

	// HTML images
	for _, m := range htmlLocalImgRe.FindAllStringSubmatchIndex(content, -1) {
		matchStr := content[m[0]:m[1]]
		rawPath := content[m[4]:m[5]]
		if !seen[rawPath] {
			seen[rawPath] = true
			images = append(images, LocalImage{
				OriginalMatch: matchStr,
				Path:          rawPath,
				IsHTML:        true,
			})
		}
	}

	// Wiki images
	for _, m := range wikiLocalImageRe.FindAllStringSubmatchIndex(content, -1) {
		matchStr := content[m[0]:m[1]]
		rawPath := content[m[2]:m[3]]
		var alt string
		if m[4] != -1 && m[5] != -1 {
			alt = content[m[4]:m[5]]
		}
		if !seen[rawPath] {
			seen[rawPath] = true
			images = append(images, LocalImage{
				OriginalMatch: matchStr,
				Path:          rawPath,
				Alt:           alt,
				IsWiki:        true,
			})
		}
	}

	return images
}

// ReplaceLocalLinks updates local image paths in markdown to their new paths (e.g. .webp).
func ReplaceLocalLinks(content string, pathToNewPath map[string]string) string {
	content = mdLocalImageRe.ReplaceAllStringFunc(content, func(match string) string {
		sub := mdLocalImageRe.FindStringSubmatch(match)
		if len(sub) < 4 {
			return match
		}
		alt := sub[1]
		rawPath := strings.Trim(sub[2], "<>")
		title := ""
		if len(sub) > 4 && sub[4] != "" {
			title = " " + sub[4]
		}
		newPath, ok := pathToNewPath[rawPath]
		if !ok {
			return match
		}
		return fmt.Sprintf("![%s](%s%s)", alt, newPath, title)
	})

	content = htmlLocalImgRe.ReplaceAllStringFunc(content, func(match string) string {
		sub := htmlLocalImgRe.FindStringSubmatch(match)
		if len(sub) < 4 {
			return match
		}
		prefix := strings.TrimSpace(sub[1])
		rawPath := sub[2]
		suffix := strings.TrimSpace(sub[3])
		newPath, ok := pathToNewPath[rawPath]
		if !ok {
			return match
		}
		var sb strings.Builder
		sb.WriteString("<img")
		if prefix != "" {
			sb.WriteString(" ")
			sb.WriteString(prefix)
		}
		sb.WriteString(fmt.Sprintf(" src=\"%s\"", newPath))
		if suffix != "" {
			sb.WriteString(" ")
			sb.WriteString(suffix)
		}
		sb.WriteString(">")
		return sb.String()
	})

	content = wikiLocalImageRe.ReplaceAllStringFunc(content, func(match string) string {
		sub := wikiLocalImageRe.FindStringSubmatch(match)
		if len(sub) < 2 {
			return match
		}
		rawPath := sub[1]
		alt := ""
		if len(sub) > 2 && sub[2] != "" {
			alt = "|" + sub[2]
		}
		newPath, ok := pathToNewPath[rawPath]
		if !ok {
			return match
		}
		return fmt.Sprintf("![[%s%s]]", newPath, alt)
	})

	return content
}
