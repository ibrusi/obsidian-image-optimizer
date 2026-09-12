package parser

import (
	"strings"
	"testing"
)

func TestExtractRemoteImages(t *testing.T) {
	mdContent := `# Test Article

Here is an image:
![Sample Diagram](https://example.com/assets/diagram.png "Architecture")

And another image without alt:
![](https://cdn.site.org/photo.jpg)

With angle brackets:
![Angle](<https://example.com/spaced%20url.png>)

HTML image:
<img src="https://images.unsplash.com/photo-123.jpeg?w=800" alt="Unsplash" width="400">

Obsidian remote wikilink:
![[https://example.com/wiki-embed.gif|Wiki Preview]]

Local image (should be ignored):
![Local](attached/local_image.png)
`

	images := ExtractRemoteImages(mdContent)
	if len(images) != 5 {
		t.Fatalf("expected 5 remote images, found %d", len(images))
	}

	expectedURLs := []string{
		"https://example.com/assets/diagram.png",
		"https://cdn.site.org/photo.jpg",
		"https://example.com/spaced%20url.png",
		"https://images.unsplash.com/photo-123.jpeg?w=800",
		"https://example.com/wiki-embed.gif",
	}

	for i, exp := range expectedURLs {
		if images[i].URL != exp {
			t.Errorf("image[%d] URL mismatch: expected %q, got %q", i, exp, images[i].URL)
		}
	}
}

func TestReplaceRemoteLinks(t *testing.T) {
	mdContent := `# Note
![My Image](https://example.com/photo.png "Title")
Text between
<img src="https://example.com/diagram.jpg" width="300">
`

	urlMap := map[string]string{
		"https://example.com/photo.png":   "attached/photo_a1b2c3d4.webp",
		"https://example.com/diagram.jpg": "attached/diagram_e5f6g7h8.webp",
	}

	// Test Markdown link format
	replacedMD := ReplaceRemoteLinks(mdContent, urlMap, "markdown")
	if !strings.Contains(replacedMD, "![My Image](attached/photo_a1b2c3d4.webp \"Title\")") {
		t.Errorf("expected markdown link replacement not found. Output:\n%s", replacedMD)
	}
	if !strings.Contains(replacedMD, "<img src=\"attached/diagram_e5f6g7h8.webp\" width=\"300\">") {
		t.Errorf("expected HTML img replacement not found. Output:\n%s", replacedMD)
	}

	// Test Wikilink format
	replacedWiki := ReplaceRemoteLinks(mdContent, urlMap, "wikilink")
	if !strings.Contains(replacedWiki, "![[attached/photo_a1b2c3d4.webp|My Image]]") {
		t.Errorf("expected wikilink replacement not found. Output:\n%s", replacedWiki)
	}
}

func TestLocalImages(t *testing.T) {
	mdContent := `# Article
![Local Photo](attached/photo.jpg "My Photo")
<img src="attached/banner.png" alt="Banner">
![[attached/anim.gif|Animation]]
![Already Webp](attached/saved.webp)
`
	images := ExtractLocalImages(mdContent)
	if len(images) != 3 {
		t.Fatalf("expected 3 local compressible images, got %d", len(images))
	}

	pathMap := map[string]string{
		"attached/photo.jpg": "attached/photo.webp",
		"attached/banner.png": "attached/banner.webp",
		"attached/anim.gif": "attached/anim.webp",
	}

	replaced := ReplaceLocalLinks(mdContent, pathMap)
	if !strings.Contains(replaced, "![Local Photo](attached/photo.webp \"My Photo\")") {
		t.Errorf("expected local markdown replacement: %s", replaced)
	}
	if !strings.Contains(replaced, "<img src=\"attached/banner.webp\" alt=\"Banner\">") {
		t.Errorf("expected local HTML replacement: %s", replaced)
	}
	if !strings.Contains(replaced, "![[attached/anim.webp|Animation]]") {
		t.Errorf("expected local wikilink replacement: %s", replaced)
	}
}
