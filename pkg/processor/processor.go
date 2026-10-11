// Package processor orchestrates a run in explicit phases:
//
//  1. collect – find the notes in scope and parse their image embeds;
//  2. plan    – group embeds into unique download / local optimisation jobs;
//  3. execute – download and optimise images in parallel (skipped in dry-run);
//  4. apply   – re-read every affected note and rewrite its links atomically;
//  5. retire  – move replaced local originals to the backup folder, but only
//     when every referencing note was written and nothing else in the vault
//     still mentions them.
//
// Destructive steps happen strictly after the steps they depend on succeed,
// so an interrupted or failed run never leaves a note pointing to a missing file.
package processor

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"obsidian-image-optimizer/pkg/config"
	"obsidian-image-optimizer/pkg/downloader"
	"obsidian-image-optimizer/pkg/fsutil"
	"obsidian-image-optimizer/pkg/imagekind"
	"obsidian-image-optimizer/pkg/optimizer"
	"obsidian-image-optimizer/pkg/parser"
	"obsidian-image-optimizer/pkg/report"
)

// dirPerm is the permission of folders created for attachments and backups.
const dirPerm = 0o755

// Processor manages the processing pipeline for markdown files and vaults.
type Processor struct {
	cfg        *config.Config
	rep        report.Reporter
	downloader *downloader.Downloader
	optimizer  *optimizer.Optimizer

	stats report.Summary
}

// New creates a Processor from its collaborators.
func New(cfg *config.Config, rep report.Reporter, dl *downloader.Downloader, opt *optimizer.Optimizer) *Processor {
	return &Processor{cfg: cfg, rep: rep, downloader: dl, optimizer: opt}
}

// Stats returns the accumulated statistics.
func (p *Processor) Stats() report.Summary {
	return p.stats
}

// note is a markdown file in scope together with the changes planned for it.
type note struct {
	path string
	dir  string

	remoteRefs []parser.ImageRef
	localRefs  []parser.ImageRef

	// remoteUpdates maps URL -> new relative path; localUpdates maps a local
	// target (as written) -> new target. Filled after execution.
	remoteUpdates map[string]string
	localUpdates  map[string]string
}

func (n *note) hasUpdates() bool {
	return len(n.remoteUpdates) > 0 || len(n.localUpdates) > 0
}

// Run executes the optimisation according to the configuration. The summary
// is always reported, also when the run is interrupted.
func (p *Processor) Run(ctx context.Context) error {
	p.stats = report.Summary{DryRun: p.cfg.DryRun}
	err := p.run(ctx)
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		p.stats.Interrupted = true
	}
	p.rep.Summary(p.stats)
	return err
}

func (p *Processor) run(ctx context.Context) error {
	v, targets, err := p.collectScope()
	if err != nil {
		return err
	}
	p.stats.FilesScanned = len(targets)

	notes := p.parseNotes(targets)
	remoteJobs := p.planRemote(notes)
	localJobs := p.planLocal(v, notes)

	if p.cfg.DryRun {
		p.reportPlan(remoteJobs, localJobs)
		return nil
	}

	p.executeRemote(ctx, remoteJobs)
	p.executeLocal(ctx, localJobs)

	p.collectRemoteUpdates(remoteJobs)
	p.collectLocalUpdates(v, localJobs)
	failedNotes := p.applyUpdates(notes, localJobs)
	p.retireOriginals(v, localJobs, failedNotes)

	return ctx.Err()
}

// collectScope determines the vault snapshot and the notes to process.
func (p *Processor) collectScope() (*vault, []string, error) {
	root := p.cfg.VaultPath
	if root != "" {
		info, err := os.Stat(root)
		if err != nil {
			return nil, nil, fmt.Errorf("vault: %w", err)
		}
		if !info.IsDir() {
			return nil, nil, fmt.Errorf("vault %s is not a directory", root)
		}
	}

	if p.cfg.FilePath != "" {
		info, err := os.Stat(p.cfg.FilePath)
		if err != nil {
			return nil, nil, fmt.Errorf("file: %w", err)
		}
		if !info.Mode().IsRegular() {
			return nil, nil, fmt.Errorf("%s is not a regular file", p.cfg.FilePath)
		}
		if root != "" && !fsutil.IsWithin(root, p.cfg.FilePath) {
			p.rep.Warn("%s is outside the vault %s; ignoring the vault", p.cfg.FilePath, root)
			root = ""
		}
		v := &vault{root: root, images: make(map[string][]string)}
		// The whole vault is only needed to resolve and safely retire local images.
		if root != "" && p.cfg.OptimizeLocal {
			scanned, err := scanVault(root, p.rep)
			if err != nil {
				return nil, nil, fmt.Errorf("vault traversal failed: %w", err)
			}
			v = scanned
		}
		return v, []string{p.cfg.FilePath}, nil
	}

	p.rep.Info("🔍 Scanning vault: %s", root)
	v, err := scanVault(root, p.rep)
	if err != nil {
		return nil, nil, fmt.Errorf("vault traversal failed: %w", err)
	}
	p.rep.Info("📄 Found %d markdown file(s)\n", len(v.notes))
	return v, v.notes, nil
}

// parseNotes reads and parses the target notes.
func (p *Processor) parseNotes(paths []string) []*note {
	notes := make([]*note, 0, len(paths))
	for _, path := range paths {
		n, err := p.parseNote(path, true)
		if err != nil {
			p.rep.Warn("Cannot read %s: %v", path, err)
			p.stats.Errors++
			continue
		}
		notes = append(notes, n)
	}
	return notes
}

func (p *Processor) parseNote(path string, withRemote bool) (*note, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	content := string(data)
	n := &note{path: path, dir: filepath.Dir(path)}
	if withRemote {
		n.remoteRefs = parser.ExtractRemoteImages(content)
	}
	if p.cfg.OptimizeLocal {
		n.localRefs = parser.ExtractLocalImages(content)
	}
	return n, nil
}

// runParallel calls fn for each index in [0, n) using at most limit
// goroutines. It stops starting new work once ctx is cancelled.
func runParallel(ctx context.Context, n, limit int, fn func(i int)) {
	sem := make(chan struct{}, limit)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		select {
		case <-ctx.Done():
			wg.Wait()
			return
		case sem <- struct{}{}:
		}
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			defer func() { <-sem }()
			fn(i)
		}(i)
	}
	wg.Wait()
}

// applyUpdates rewrites every note that has planned link changes. Each note
// is re-read right before writing, so edits made while images were being
// downloaded are preserved. It returns the notes whose update failed.
func (p *Processor) applyUpdates(targets []*note, localJobs []*localJob) map[string]bool {
	byPath := make(map[string]*note)
	for _, n := range targets {
		byPath[n.path] = n
	}
	for _, job := range localJobs {
		for _, ref := range job.refs {
			byPath[ref.note.path] = ref.note
		}
	}

	paths := make([]string, 0, len(byPath))
	for path, n := range byPath {
		if n.hasUpdates() {
			paths = append(paths, path)
		}
	}
	sort.Strings(paths)

	failed := make(map[string]bool)
	for _, path := range paths {
		n := byPath[path]
		changed, err := p.applyLinkUpdates(n)
		if err != nil {
			p.rep.Warn("Failed to update links in %s: %v", path, err)
			p.stats.Errors++
			failed[path] = true
			continue
		}
		if changed {
			p.stats.FilesModified++
			p.rep.Info("   💾 Updated %d image link(s) in %s",
				len(n.remoteUpdates)+len(n.localUpdates), filepath.Base(path))
		}
	}
	return failed
}

func (p *Processor) applyLinkUpdates(n *note) (bool, error) {
	info, err := os.Stat(n.path)
	if err != nil {
		return false, err
	}
	fresh, err := os.ReadFile(n.path) // the note may have been edited meanwhile
	if err != nil {
		return false, err
	}

	content := string(fresh)
	updated := parser.ReplaceRemoteLinks(content, n.remoteUpdates, p.cfg.LinkFormat)
	updated = parser.ReplaceLocalLinks(updated, n.localUpdates)
	if updated == content {
		return false, nil
	}
	return true, fsutil.WriteFileAtomic(n.path, []byte(updated), info.Mode().Perm())
}

func (p *Processor) reportPlan(remoteJobs []*remoteJob, localJobs []*localJob) {
	for _, job := range remoteJobs {
		p.rep.Info("   [DRY-RUN] Would download %s -> %s", truncate(job.url, 80), job.dir)
	}
	for _, job := range localJobs {
		p.rep.Info("   [DRY-RUN] Would optimize %s (%d reference(s))", job.path, len(job.refs))
	}
	p.stats.PlannedDownloads = len(remoteJobs)
	p.stats.PlannedLocal = len(localJobs)
}

func (p *Processor) recordResult(res *optimizer.Result) {
	p.stats.OriginalBytes += res.OriginalSize
	p.stats.OptimizedBytes += res.FinalSize
	if res.Improved() {
		p.stats.ImagesCompressed++
	} else {
		p.stats.OriginalsKept++
	}
}

func (p *Processor) describeKept(name string, res *optimizer.Result) {
	if res.EncodeErr != nil {
		p.rep.Warn("Kept original %s: %s: %v", name, res.KeptReason, res.EncodeErr)
		return
	}
	p.rep.Info("   ℹ️  Kept original %s (%s, %s)", name, report.FormatHumanBytes(res.OriginalSize), res.KeptReason)
}

// stemAndExt splits a file name into stem and lower-cased extension.
func stemAndExt(path string) (string, string) {
	base := filepath.Base(path)
	ext := filepath.Ext(base)
	return strings.TrimSuffix(base, ext), strings.ToLower(ext)
}

// moveToBackup moves src into backupDir under a free name.
func moveToBackup(src, backupDir string) (string, error) {
	if err := os.MkdirAll(backupDir, dirPerm); err != nil {
		return "", err
	}
	stem, ext := stemAndExt(src)
	return fsutil.CommitUnique(src, backupDir, stem, ext)
}

func truncate(s string, maxLen int) string {
	r := []rune(s)
	if len(r) <= maxLen {
		return s
	}
	return string(r[:maxLen-3]) + "..."
}

// kindOf sniffs the real format of a local file.
func kindOf(path string) imagekind.Kind {
	kind, err := imagekind.SniffFile(path)
	if err != nil {
		return imagekind.Unknown
	}
	return kind
}
