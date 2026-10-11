package parser

import (
	"strings"
	"testing"

	"obsidian-image-optimizer/pkg/config"
)

func targets(refs []ImageRef) []string {
	out := make([]string, len(refs))
	for i, r := range refs {
		out[i] = r.Target
	}
	return out
}

func TestExtractRemoteImages(t *testing.T) {
	tests := []struct {
		name    string
		content string
		want    []string
	}{
		{"markdown", `![Logo](https://example.com/logo.png)`, []string{"https://example.com/logo.png"}},
		{"markdown with title", `![A](https://x.com/a.jpg "Title")`, []string{"https://x.com/a.jpg"}},
		{"angle brackets", `![A](<https://x.com/a b.png>)`, []string{"https://x.com/a b.png"}},
		{"parentheses in url", `![W](https://upload.wikimedia.org/File:Foo_(bar).png)`, []string{"https://upload.wikimedia.org/File:Foo_(bar).png"}},
		{"html", `<img alt="x" src="https://example.com/b.png" width="100">`, []string{"https://example.com/b.png"}},
		{"html single quotes", `<IMG SRC='http://example.com/c.gif'>`, []string{"http://example.com/c.gif"}},
		{"html entities", `<img src="https://x.com/i.png?a=1&amp;b=2">`, []string{"https://x.com/i.png?a=1&b=2"}},
		{"data-src is not src", `<img data-src="https://x.com/lazy.png" src="https://x.com/real.png">`, []string{"https://x.com/real.png"}},
		{"wikilink", `![[https://example.com/wiki.webp|My alt]]`, []string{"https://example.com/wiki.webp"}},
		{"local ignored", `![l](attachments/local.png) ![[pic.png]]`, nil},
		{"fenced code ignored", "```md\n![x](https://x.com/a.png)\n```", nil},
		{"tilde fence ignored", "~~~\n![x](https://x.com/a.png)\n~~~", nil},
		{"longer fence", "````\n```\n![x](https://x.com/a.png)\n```\n````\n![y](https://x.com/b.png)", []string{"https://x.com/b.png"}},
		{"unclosed fence runs to end", "```\n![x](https://x.com/a.png)", nil},
		{"inline code ignored", "Use `![x](https://x.com/a.png)` here ![y](https://x.com/b.png)", []string{"https://x.com/b.png"}},
		{"double backtick code", "``![x](https://x.com/a.png)`` ![y](https://x.com/b.png)", []string{"https://x.com/b.png"}},
		{"html comment ignored", "<!-- ![x](https://x.com/a.png) --> ![y](https://x.com/b.png)", []string{"https://x.com/b.png"}},
		{"obsidian comment ignored", "%% ![x](https://x.com/a.png) %% ![y](https://x.com/b.png)", []string{"https://x.com/b.png"}},
		{"indented list item kept", "- item\n    ![y](https://x.com/b.png)", []string{"https://x.com/b.png"}},
		{"escaped backtick is literal", "\\` ![y](https://x.com/b.png) \\`", []string{"https://x.com/b.png"}},
		{"non-image link ignored", `[link](https://x.com/a.png)`, nil},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := targets(ExtractRemoteImages(tt.content))
			if strings.Join(got, "\n") != strings.Join(tt.want, "\n") {
				t.Errorf("got %q, want %q", got, tt.want)
			}
		})
	}
}

func TestExtractLocalImages(t *testing.T) {
	content := "![a](attachments/a.png)\n" +
		"![b](<my folder/b.JPG> \"t\")\n" +
		"![c](my%20pic.jpeg)\n" +
		"<img src=\"img/c.gif\">\n" +
		"![[d.bmp|300]]\n" +
		"![[sub/e.tiff]]\n" +
		"![skip](f.webp) ![skip](g.svg) ![skip](data:image/png;base64,AAA) ![skip](https://x/y.png)\n" +
		"`![skip](h.png)`\n"

	refs := ExtractLocalImages(content)
	want := []string{"attachments/a.png", "my folder/b.JPG", "my%20pic.jpeg", "img/c.gif", "d.bmp", "sub/e.tiff"}
	if got := targets(refs); strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("got %q, want %q", got, want)
	}
	if refs[2].DecodedPath() != "my pic.jpeg" {
		t.Errorf("DecodedPath = %q", refs[2].DecodedPath())
	}
	if refs[4].Kind != Wiki || refs[4].Alt != "300" {
		t.Errorf("unexpected wiki ref %+v", refs[4])
	}
}

func TestReplaceRemoteLinksMarkdown(t *testing.T) {
	content := "![Diagram](https://x.com/d.png \"Title\")\n" +
		"<img class=\"c\" src=\"https://x.com/s.png\" alt=\"A &amp; B\">\n" +
		"![[https://x.com/w.png|alt]]\n" +
		"```\n![Diagram](https://x.com/d.png)\n```\n" +
		"![Untouched](https://x.com/other.png)\n"
	urlMap := map[string]string{
		"https://x.com/d.png": "attachments/d.webp",
		"https://x.com/s.png": "attachments/s&t.webp",
		"https://x.com/w.png": "attachments/w.webp",
	}

	want := "![Diagram](attachments/d.webp \"Title\")\n" +
		"<img class=\"c\" src=\"attachments/s&amp;t.webp\" alt=\"A &amp; B\">\n" +
		"![[attachments/w.webp|alt]]\n" +
		"```\n![Diagram](https://x.com/d.png)\n```\n" +
		"![Untouched](https://x.com/other.png)\n"

	if got := ReplaceRemoteLinks(content, urlMap, config.LinkFormatMarkdown); got != want {
		t.Errorf("got:\n%s\nwant:\n%s", got, want)
	}
}

func TestReplaceRemoteLinksWikilinkFormat(t *testing.T) {
	content := "![My | Alt](https://x.com/a.png) ![](https://x.com/b.png) <img src=\"https://x.com/a.png\">"
	urlMap := map[string]string{
		"https://x.com/a.png": "attachments/a.webp",
		"https://x.com/b.png": "attachments/b.webp",
	}
	want := "![[attachments/a.webp|My   Alt]] ![[attachments/b.webp]] <img src=\"attachments/a.webp\">"
	if got := ReplaceRemoteLinks(content, urlMap, config.LinkFormatWikilink); got != want {
		t.Errorf("got  %q\nwant %q", got, want)
	}
}

func TestReplaceRemoteLinksQuotesPathsWithSpaces(t *testing.T) {
	got := ReplaceRemoteLinks("![a](https://x.com/a.png)",
		map[string]string{"https://x.com/a.png": "My Files/a.webp"}, config.LinkFormatMarkdown)
	if got != "![a](<My Files/a.webp>)" {
		t.Errorf("got %q", got)
	}
}

func TestReplaceLocalLinks(t *testing.T) {
	content := "![a](img/a.png \"t\") ![[a.png|200]] <img src=\"img/a.png\"> `![a](img/a.png)`"
	got := ReplaceLocalLinks(content, map[string]string{
		"img/a.png": "img/a.webp",
		"a.png":     "img/a.webp",
	})
	want := "![a](img/a.webp \"t\") ![[img/a.webp|200]] <img src=\"img/a.webp\"> `![a](img/a.png)`"
	if got != want {
		t.Errorf("got  %q\nwant %q", got, want)
	}
}

func TestReplaceLastSegment(t *testing.T) {
	tests := []struct{ target, name, want string }{
		{"pic.png", "pic.webp", "pic.webp"},
		{"../img/pic.png", "pic-1.webp", "../img/pic-1.webp"},
		{"my%20dir/my%20pic.png", "my pic.webp", "my%20dir/my%20pic.webp"},
	}
	for _, tt := range tests {
		if got := ReplaceLastSegment(tt.target, tt.name); got != tt.want {
			t.Errorf("ReplaceLastSegment(%q, %q) = %q, want %q", tt.target, tt.name, got, tt.want)
		}
	}
}

func TestIsLocal(t *testing.T) {
	for target, want := range map[string]bool{
		"pic.png":              true,
		"../a/b.png":           true,
		"C:/x.png":             true, // a drive letter is not a URI scheme
		"https://x.com/a.png":  false,
		"data:image/png;base6": false,
		"obsidian://open":      false,
		"#heading":             false,
		"":                     false,
	} {
		if got := IsLocal(target); got != want {
			t.Errorf("IsLocal(%q) = %v, want %v", target, got, want)
		}
	}
}

func TestReplaceIsIdempotentWhenNothingMatches(t *testing.T) {
	content := "no images here\n```\ncode\n```\n"
	if got := ReplaceRemoteLinks(content, map[string]string{"x": "y"}, config.LinkFormatMarkdown); got != content {
		t.Errorf("content changed: %q", got)
	}
}
