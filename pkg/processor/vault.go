package processor

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"obsidian-image-optimizer/pkg/fsutil"
	"obsidian-image-optimizer/pkg/imagekind"
	"obsidian-image-optimizer/pkg/report"
)

var (
	errNotFound     = errors.New("file not found")
	errOutsideScope = errors.New("path points outside the vault")
	errAmbiguous    = errors.New("link matches several files in the vault")
)

// vault is a snapshot of the files the run may read or touch.
type vault struct {
	// root is the vault root; empty when only a single file is processed
	// without --vault, in which case local originals are never retired.
	root string

	notes     []string // markdown notes
	textFiles []string // notes and canvases: everything that can reference an image

	// images indexes image files by lower-cased base name, which is how
	// Obsidian resolves links that are not plain relative paths.
	images map[string][]string
}

// scanVault walks root, skipping hidden folders (.obsidian, .trash, backups)
// and node_modules. Unreadable folders are reported and skipped.
func scanVault(root string, rep report.Reporter) (*vault, error) {
	v := &vault{root: root, images: make(map[string][]string)}

	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			if path == root {
				return err
			}
			rep.Warn("Skipping %s: %v", path, err)
			if d != nil && d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}

		name := d.Name()
		if d.IsDir() {
			if path != root && (strings.HasPrefix(name, ".") || name == "node_modules") {
				return filepath.SkipDir
			}
			return nil
		}
		if !d.Type().IsRegular() || strings.HasPrefix(name, fsutil.TempPrefix) {
			return nil
		}

		switch ext := strings.ToLower(filepath.Ext(name)); {
		case ext == ".md":
			v.notes = append(v.notes, path)
			v.textFiles = append(v.textFiles, path)
		case ext == ".canvas":
			v.textFiles = append(v.textFiles, path)
		case imagekind.IsImageExt(name):
			v.addImage(path)
		}
		return nil
	})
	return v, err
}

func (v *vault) addImage(path string) {
	key := strings.ToLower(filepath.Base(path))
	v.images[key] = append(v.images[key], path)
}

// nameCount returns how many indexed images share the base name of path.
func (v *vault) nameCount(name string) int {
	return len(v.images[strings.ToLower(name)])
}

// allowedRoot is the folder local files must stay within.
func (v *vault) allowedRoot(noteDir string) string {
	if v.root != "" {
		return v.root
	}
	return noteDir
}

// resolution is the outcome of resolving a link to a file.
type resolution struct {
	path string
	// byName is true when the file was found through the vault index rather
	// than as a path relative to the note or the vault root.
	byName bool
}

// resolve finds the file a local link points to, the way Obsidian does: as
// a path relative to the note, then relative to the vault root, then by
// (partial) path anywhere in the vault. Files whose real location is outside
// the vault, symlinked files and ambiguous names are rejected. The returned
// path is the real one, with symlinked parent folders resolved.
func (v *vault) resolve(noteDir, linkPath string) (resolution, error) {
	if linkPath == "" {
		return resolution{}, errNotFound
	}
	allowed := v.allowedRoot(noteDir)
	rel := filepath.FromSlash(strings.TrimPrefix(linkPath, "/"))

	var candidates []string
	if !strings.HasPrefix(linkPath, "/") {
		candidates = append(candidates, filepath.Join(noteDir, rel))
	}
	if v.root != "" {
		candidates = append(candidates, filepath.Join(v.root, rel))
	}

	outside := false
	for _, c := range candidates {
		real, ok := containedFile(allowed, c)
		if !ok {
			// The file exists, but its real location is outside the vault
			// (a ../ link or a symlinked folder): it must not be touched.
			outside = outside || isRegularFile(c)
			continue
		}
		return resolution{path: real}, nil
	}

	if v.root != "" {
		var matches []string
		suffix := "/" + strings.ToLower(strings.TrimPrefix(linkPath, "/"))
		for _, img := range v.images[strings.ToLower(filepath.Base(rel))] {
			if strings.HasSuffix(strings.ToLower(filepath.ToSlash(img)), suffix) {
				matches = append(matches, img)
			}
		}
		switch len(matches) {
		case 0:
		case 1:
			return resolution{path: matches[0], byName: true}, nil
		default:
			return resolution{}, errAmbiguous
		}
	}

	if outside {
		return resolution{}, errOutsideScope
	}
	return resolution{}, errNotFound
}

// containedFile returns the real path of a regular file if it stays within
// root after every symlinked parent folder is resolved. root must be real.
// A symlink as the file itself is rejected: retiring it would remove the link
// but keep the file it points to, or worse, follow it.
func containedFile(root, path string) (string, bool) {
	if !isRegularFile(path) {
		return "", false
	}
	real, err := filepath.EvalSymlinks(path)
	if err != nil || !fsutil.IsWithin(root, real) {
		return "", false
	}
	return real, true
}

// isRegularFile reports whether path is a regular file and not a symlink.
func isRegularFile(path string) bool {
	info, err := os.Lstat(path)
	return err == nil && info.Mode().IsRegular()
}

// referenceScanBatch bounds the number of names in one search expression.
const referenceScanBatch = 256

// findMentions returns the subset of file names (base names) that are still
// mentioned anywhere in the vault's notes and canvases. Any mention counts:
// links in properties, plain [[links]], canvases and prose all keep a file
// alive, so an original is only retired when nothing can refer to it.
func (v *vault) findMentions(names []string, rep report.Reporter) map[string]bool {
	found := make(map[string]bool)
	if len(names) == 0 {
		return found
	}

	// Each name is searched literally and percent-encoded ("my pic.png" and
	// "my%20pic.png"), case-insensitively.
	variants := make(map[string]string) // lower-cased variant -> name
	for _, n := range names {
		variants[strings.ToLower(n)] = n
		variants[strings.ToLower(strings.ReplaceAll(n, " ", "%20"))] = n
	}
	var patterns []*regexp.Regexp
	var batch []string
	flush := func() {
		if len(batch) > 0 {
			patterns = append(patterns, regexp.MustCompile("(?i)"+strings.Join(batch, "|")))
			batch = batch[:0]
		}
	}
	for variant := range variants {
		batch = append(batch, regexp.QuoteMeta(variant))
		if len(batch) == referenceScanBatch {
			flush()
		}
	}
	flush()

	for _, file := range v.textFiles {
		data, err := os.ReadFile(file)
		if err != nil {
			// Unreadable files may reference anything: keep every original.
			rep.Warn("Cannot read %s to check references: %v", file, err)
			for _, n := range names {
				found[n] = true
			}
			return found
		}
		for _, re := range patterns {
			for _, m := range re.FindAll(data, -1) {
				found[variants[strings.ToLower(string(m))]] = true
			}
		}
	}
	return found
}
