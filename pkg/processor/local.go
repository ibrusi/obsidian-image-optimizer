package processor

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"obsidian-image-optimizer/pkg/fsutil"
	"obsidian-image-optimizer/pkg/imagekind"
	"obsidian-image-optimizer/pkg/optimizer"
	"obsidian-image-optimizer/pkg/parser"
)

// localRef is one embed of a local image in a note.
type localRef struct {
	note   *note
	target string // as written in the note (parser.ImageRef.Target)
	byName bool   // resolved through the vault index, not as a relative path
}

// localJob optimises one local image file and updates every note that embeds it.
type localJob struct {
	path string
	kind imagekind.Kind
	refs []localRef

	// Results.
	result  *optimizer.Result
	newPath string
	err     error
}

// planLocal resolves the local embeds of the target notes to unique files
// and, when the vault is known, adds embeds of the same files from every
// other note, so that all of them are rewritten together.
func (p *Processor) planLocal(v *vault, targets []*note) []*localJob {
	if !p.cfg.OptimizeLocal {
		return nil
	}

	byPath := make(map[string]*localJob)
	var jobs []*localJob
	addRef := func(n *note, ref parser.ImageRef, fromTarget bool) {
		res, err := v.resolve(n.dir, ref.DecodedPath())
		if err != nil {
			if fromTarget {
				p.rep.Debug("   ⚠️  Skipping %s in %s: %v", ref.Target, filepath.Base(n.path), err)
			}
			return
		}
		job, ok := byPath[res.path]
		if !ok {
			if !fromTarget {
				return // other notes only join jobs started by the targets
			}
			kind := kindOf(res.path)
			if kind == imagekind.Unknown || kind == imagekind.WebP {
				p.rep.Debug("   ⚠️  Skipping %s: not a supported raster image", ref.Target)
				return
			}
			job = &localJob{path: res.path, kind: kind}
			byPath[res.path] = job
			jobs = append(jobs, job)
		}
		job.refs = append(job.refs, localRef{note: n, target: ref.Target, byName: res.byName})
	}

	isTarget := make(map[string]bool, len(targets))
	for _, n := range targets {
		isTarget[n.path] = true
		if len(n.localRefs) > 0 {
			p.rep.Info("📁 [%s] Found %d local image(s)", filepath.Base(n.path), len(n.localRefs))
		}
		for _, ref := range n.localRefs {
			addRef(n, ref, true)
		}
	}

	if len(jobs) > 0 && v.root != "" {
		for _, path := range v.notes {
			if isTarget[path] {
				continue
			}
			n, err := p.parseNote(path, false)
			if err != nil {
				p.rep.Warn("Cannot read %s: %v", path, err)
				continue
			}
			for _, ref := range n.localRefs {
				addRef(n, ref, false)
			}
		}
	}

	sort.Slice(jobs, func(i, j int) bool { return jobs[i].path < jobs[j].path })
	return jobs
}

func (p *Processor) executeLocal(ctx context.Context, jobs []*localJob) {
	// Encoding runs in parallel; committing runs sequentially in job order,
	// so the names chosen for new files are deterministic across runs.
	runParallel(ctx, len(jobs), p.cfg.Concurrency, func(i int) {
		job := jobs[i]
		job.result, job.err = p.optimizer.Optimize(ctx, job.path, job.kind, filepath.Dir(job.path))
	})

	for _, job := range jobs {
		if job.err == nil && job.result != nil && job.result.Improved() {
			job.newPath, job.err = commitLocal(job)
		}

		switch {
		case job.err == nil && job.result == nil:
			// Never started: the run was interrupted.
		case job.err != nil:
			if !errors.Is(job.err, context.Canceled) {
				p.rep.Warn("Failed to optimize %s: %v", job.path, job.err)
			}
			p.stats.ImagesFound++
			p.stats.Errors++
		default:
			p.stats.ImagesFound++
			p.recordResult(job.result)
			if job.result.Improved() {
				p.rep.Info("   ✨ Compressed local %s -> %s (-%.1f%%)",
					filepath.Base(job.path), filepath.Base(job.newPath), job.result.SavingsPercent())
			} else {
				p.describeKept(filepath.Base(job.path), job.result)
			}
		}
	}
}

// commitLocal publishes the optimised candidate next to the original under a
// free name; the original itself is left untouched here.
func commitLocal(job *localJob) (string, error) {
	defer os.Remove(job.result.Candidate) // no-op once committed

	stem, ext := stemAndExt(job.path)
	if job.result.Ext == ext {
		stem += "_opt" // GIF re-encoded as GIF: keep both names distinguishable
	}
	return fsutil.CommitUnique(job.result.Candidate, filepath.Dir(job.path), stem, job.result.Ext)
}

// collectLocalUpdates computes the new link target of every embed of an
// optimised image, preserving the style of the original link.
func (p *Processor) collectLocalUpdates(v *vault, jobs []*localJob) {
	for _, job := range jobs {
		if job.newPath != "" {
			v.addImage(job.newPath)
		}
	}

	for _, job := range jobs {
		if job.newPath == "" {
			continue
		}
		newName := filepath.Base(job.newPath)
		for _, ref := range job.refs {
			newTarget := parser.ReplaceLastSegment(ref.target, newName)
			if v.root != "" && needsVaultPath(v, ref, newName) {
				if rel, err := filepath.Rel(v.root, job.newPath); err == nil {
					newTarget = filepath.ToSlash(rel)
				}
			}
			if ref.note.localUpdates == nil {
				ref.note.localUpdates = make(map[string]string)
			}
			ref.note.localUpdates[ref.target] = newTarget
		}
	}
}

// needsVaultPath reports whether a link resolved by name must be rewritten
// as a full vault path: when the original was found through the vault index
// or when the new bare name would be ambiguous in the vault.
func needsVaultPath(v *vault, ref localRef, newName string) bool {
	if ref.byName {
		return true
	}
	bareName := !strings.Contains(strings.TrimPrefix(ref.target, "/"), "/")
	return bareName && v.nameCount(newName) > 1
}

// retireOriginals moves (or deletes, without --keep-backup) the originals of
// optimised local images. An original is retired only when the vault root is
// known, every note embedding it was rewritten, and no note or canvas in the
// vault mentions its file name any more.
func (p *Processor) retireOriginals(v *vault, jobs []*localJob, failedNotes map[string]bool) {
	var candidates []*localJob
	for _, job := range jobs {
		if job.newPath == "" {
			continue
		}
		if v.root == "" {
			p.rep.Debug("   ℹ️  Kept %s next to its optimized copy: pass --vault to allow replacing it", filepath.Base(job.path))
			p.stats.OriginalsStillReferenced++
			continue
		}
		if refsFailed(job, failedNotes) {
			p.stats.OriginalsStillReferenced++
			continue
		}
		candidates = append(candidates, job)
	}
	if len(candidates) == 0 {
		return
	}

	names := make([]string, 0, len(candidates))
	for _, job := range candidates {
		names = append(names, filepath.Base(job.path))
	}
	mentioned := v.findMentions(names, p.rep)

	for _, job := range candidates {
		name := filepath.Base(job.path)
		if mentioned[name] {
			p.rep.Info("   🔗 Kept original %s: its name is still mentioned in the vault", name)
			p.stats.OriginalsStillReferenced++
			continue
		}
		if err := p.retire(job.path); err != nil {
			p.rep.Warn("Cannot retire original %s: %v", job.path, err)
			p.stats.Errors++
		}
	}
}

func refsFailed(job *localJob, failedNotes map[string]bool) bool {
	for _, ref := range job.refs {
		if failedNotes[ref.note.path] {
			return true
		}
	}
	return false
}

func (p *Processor) retire(path string) error {
	if !p.cfg.KeepBackup {
		return os.Remove(path)
	}
	_, err := moveToBackup(path, filepath.Join(filepath.Dir(path), p.cfg.BackupDir))
	return err
}
