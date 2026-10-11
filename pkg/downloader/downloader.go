// Package downloader fetches remote images into temp files. Only responses
// whose content is a recognised image are accepted, sizes are capped, and by
// default connections to non-public addresses are refused (SSRF protection).
package downloader

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"regexp"
	"strings"
	"time"

	"obsidian-image-optimizer/pkg/fsutil"
	"obsidian-image-optimizer/pkg/imagekind"
)

var (
	// ErrNotAnImage means the response body is not a supported image (for
	// example an HTML "hotlinking denied" page served with status 200).
	ErrNotAnImage = errors.New("response is not a supported image")
	// ErrTooLarge means the response exceeds the configured size limit.
	ErrTooLarge = errors.New("response exceeds the download size limit")
	// ErrForbiddenHost means the URL resolves to a non-public address.
	ErrForbiddenHost = errors.New("host resolves to a private, loopback or link-local address (use --allow-private-hosts to permit)")
)

const maxRedirects = 10

var safeFilenameRe = regexp.MustCompile(`[^a-zA-Z0-9_\-.]`)

// Options configure a Downloader.
type Options struct {
	Timeout           time.Duration
	UserAgent         string
	MaxBytes          int64
	AllowPrivateHosts bool
}

// Downloader handles fetching remote images and saving them locally.
type Downloader struct {
	client    *http.Client
	userAgent string
	maxBytes  int64

	// checkProxied resolves and checks target hosts of proxied requests,
	// which the dial guard cannot see; nil when private hosts are allowed.
	checkProxied func(ctx context.Context, u *url.URL) error
}

// Result describes a downloaded image stored in a temp file.
type Result struct {
	URL string
	// TempPath is the downloaded file; the caller must commit or remove it.
	TempPath string
	// BaseName is a safe, collision-resistant file stem derived from the URL.
	BaseName string
	Kind     imagekind.Kind
	Size     int64
}

// New creates a Downloader.
func New(opts Options) *Downloader {
	dialer := &net.Dialer{Timeout: opts.Timeout, KeepAlive: 30 * time.Second}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.DialContext = dialer.DialContext

	d := &Downloader{userAgent: opts.UserAgent, maxBytes: opts.MaxBytes}
	if !opts.AllowPrivateHosts {
		transport.DialContext = guardedDial(dialer, proxyAddrs())
		d.checkProxied = proxiedTargetCheck(transport.Proxy, net.DefaultResolver)
	}

	d.client = &http.Client{
		Timeout:   opts.Timeout,
		Transport: transport,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= maxRedirects {
				return fmt.Errorf("stopped after %d redirects", maxRedirects)
			}
			if req.URL.Scheme != "http" && req.URL.Scheme != "https" {
				return fmt.Errorf("redirect to unsupported scheme %q", req.URL.Scheme)
			}
			return d.checkTarget(req.Context(), req.URL)
		},
	}
	return d
}

func (d *Downloader) checkTarget(ctx context.Context, u *url.URL) error {
	if d.checkProxied == nil {
		return nil
	}
	return d.checkProxied(ctx, u)
}

// Download fetches rawURL into a temp file inside destDir (which must exist).
func (d *Downloader) Download(ctx context.Context, rawURL, destDir string) (*Result, error) {
	parsedURL, err := url.Parse(rawURL)
	if err != nil {
		return nil, fmt.Errorf("invalid url: %w", err)
	}
	if parsedURL.Scheme != "http" && parsedURL.Scheme != "https" {
		return nil, fmt.Errorf("unsupported url scheme %q", parsedURL.Scheme)
	}

	if err := d.checkTarget(ctx, parsedURL); err != nil {
		return nil, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("User-Agent", d.userAgent)
	req.Header.Set("Accept", "image/webp,image/png,image/jpeg,image/gif,image/svg+xml,image/*;q=0.8")

	resp, err := d.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %s", resp.Status)
	}
	if d.maxBytes > 0 && resp.ContentLength > d.maxBytes {
		return nil, fmt.Errorf("%w (%d bytes)", ErrTooLarge, resp.ContentLength)
	}

	head := make([]byte, imagekind.SniffLen)
	n, err := io.ReadFull(resp.Body, head)
	if err != nil && err != io.EOF && err != io.ErrUnexpectedEOF {
		return nil, fmt.Errorf("read response: %w", err)
	}
	head = head[:n]

	kind := detectKind(head, resp.Header.Get("Content-Type"), parsedURL.Path)
	if kind == imagekind.Unknown {
		return nil, ErrNotAnImage
	}

	f, err := fsutil.CreateTemp(destDir, kind.Ext())
	if err != nil {
		return nil, fmt.Errorf("create temp file: %w", err)
	}
	tmpPath := f.Name()
	committed := false
	defer func() {
		if !committed {
			os.Remove(tmpPath)
		}
	}()

	size, err := d.copyLimited(f, head, resp.Body)
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return nil, err
	}

	committed = true
	return &Result{
		URL:      rawURL,
		TempPath: tmpPath,
		BaseName: BaseName(parsedURL, rawURL),
		Kind:     kind,
		Size:     size,
	}, nil
}

// copyLimited writes the already-read head and the rest of body to w,
// failing with ErrTooLarge once more than maxBytes would be written.
func (d *Downloader) copyLimited(w io.Writer, head []byte, body io.Reader) (int64, error) {
	if d.maxBytes > 0 && int64(len(head)) > d.maxBytes {
		return 0, ErrTooLarge
	}
	if _, err := w.Write(head); err != nil {
		return 0, fmt.Errorf("write: %w", err)
	}

	rest := body
	if d.maxBytes > 0 {
		rest = io.LimitReader(body, d.maxBytes-int64(len(head))+1)
	}
	n, err := io.Copy(w, rest)
	total := int64(len(head)) + n
	if err != nil {
		return total, fmt.Errorf("download body: %w", err)
	}
	if d.maxBytes > 0 && total > d.maxBytes {
		return total, ErrTooLarge
	}
	return total, nil
}

// detectKind trusts magic bytes for raster formats. SVG has no magic bytes,
// so it is accepted only when the server or URL claims SVG and the body
// actually contains an <svg> element.
func detectKind(head []byte, contentType, urlPath string) imagekind.Kind {
	if kind := imagekind.Sniff(head); kind != imagekind.Unknown {
		return kind
	}
	mediaType, _, _ := mime.ParseMediaType(contentType)
	claimsSVG := strings.EqualFold(mediaType, "image/svg+xml") ||
		strings.EqualFold(path.Ext(urlPath), ".svg")
	if claimsSVG && imagekind.SniffSVG(head) {
		return imagekind.SVG
	}
	return imagekind.Unknown
}

// BaseName creates a clean, collision-resistant file stem from the URL: a
// sanitised name from the URL path plus a short hash of the full URL.
func BaseName(parsedURL *url.URL, rawURL string) string {
	name := path.Base(parsedURL.Path)
	name = strings.TrimSuffix(name, path.Ext(name))
	name = safeFilenameRe.ReplaceAllString(name, "_")
	name = strings.Trim(name, "_.")

	if len(name) < 3 || strings.EqualFold(name, "image") || strings.EqualFold(name, "download") {
		name = "img"
	}
	if len(name) > 40 {
		name = name[:40]
	}

	sum := sha256.Sum256([]byte(rawURL))
	return name + "_" + hex.EncodeToString(sum[:])[:8]
}
