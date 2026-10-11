package processor

import (
	"context"
	"errors"
	"os"
	"path/filepath"

	"obsidian-image-optimizer/pkg/downloader"
	"obsidian-image-optimizer/pkg/fsutil"
	"obsidian-image-optimizer/pkg/optimizer"
	"obsidian-image-optimizer/pkg/report"
)

// remoteJob downloads one URL into one attachments folder. Notes in the same
// folder that embed the same URL share a single job.
type remoteJob struct {
	url string
	dir string // absolute attachments folder

	notes []*note

	// Results.
	finalPath string
	result    *optimizer.Result
	err       error
}

func (p *Processor) planRemote(notes []*note) []*remoteJob {
	byKey := make(map[string]*remoteJob)
	var jobs []*remoteJob

	for _, n := range notes {
		if len(n.remoteRefs) == 0 {
			continue
		}
		p.rep.Info("📝 [%s] Found %d remote image(s)", filepath.Base(n.path), len(n.remoteRefs))

		dir := filepath.Join(n.dir, p.cfg.AttachedDir)
		seen := make(map[string]bool)
		for _, ref := range n.remoteRefs {
			if seen[ref.Target] {
				continue
			}
			seen[ref.Target] = true

			key := dir + "\x00" + ref.Target
			job, ok := byKey[key]
			if !ok {
				job = &remoteJob{url: ref.Target, dir: dir}
				byKey[key] = job
				jobs = append(jobs, job)
			}
			job.notes = append(job.notes, n)
		}
	}
	return jobs
}

func (p *Processor) executeRemote(ctx context.Context, jobs []*remoteJob) {
	// Downloads and encoding run in parallel; committing runs sequentially in
	// job order, so the names chosen for new files are deterministic.
	downloads := make([]*downloader.Result, len(jobs))
	runParallel(ctx, len(jobs), p.cfg.Concurrency, func(i int) {
		downloads[i], jobs[i].result, jobs[i].err = p.fetchAndOptimize(ctx, jobs[i])
	})

	for i, job := range jobs {
		if dl := downloads[i]; dl != nil {
			if job.err == nil {
				job.finalPath, job.err = p.commitRemote(job, dl)
			}
			p.discard(dl, job.result)
		}

		switch {
		case job.err == nil && job.result == nil:
			// Never started: the run was interrupted.
		case job.err != nil:
			if !errors.Is(job.err, context.Canceled) {
				p.rep.Warn("Failed to fetch %s: %v", truncate(job.url, 80), job.err)
			}
			p.stats.ImagesFound++
			p.stats.Errors++
		default:
			p.stats.ImagesFound++
			p.recordResult(job.result)
			p.reportOptimized(filepath.Base(job.finalPath), job.result)
		}
	}
}

// fetchAndOptimize downloads the image and optimises it. Both results stay in
// temp files until commitRemote publishes them.
func (p *Processor) fetchAndOptimize(ctx context.Context, job *remoteJob) (*downloader.Result, *optimizer.Result, error) {
	p.rep.Info("   ⬇️  Downloading: %s", truncate(job.url, 60))

	if err := os.MkdirAll(job.dir, dirPerm); err != nil {
		return nil, nil, err
	}
	dl, err := p.downloader.Download(ctx, job.url, job.dir)
	if err != nil {
		return nil, nil, err
	}
	res, err := p.optimizer.Optimize(ctx, dl.TempPath, dl.Kind, job.dir)
	return dl, res, err
}

// commitRemote publishes the smaller of the original and the optimised
// version under a free name in the attachments folder. When the optimised
// version wins, the original goes to the backup folder.
func (p *Processor) commitRemote(job *remoteJob, dl *downloader.Result) (string, error) {
	if !job.result.Improved() {
		return fsutil.CommitUnique(dl.TempPath, job.dir, dl.BaseName, dl.Kind.Ext())
	}
	final, err := fsutil.CommitUnique(job.result.Candidate, job.dir, dl.BaseName, job.result.Ext)
	if err != nil {
		return "", err
	}
	p.retireDownloaded(dl)
	return final, nil
}

// discard removes whatever temp files of a job were not committed.
func (p *Processor) discard(dl *downloader.Result, res *optimizer.Result) {
	os.Remove(dl.TempPath)
	if res != nil && res.Candidate != "" {
		os.Remove(res.Candidate)
	}
}

// retireDownloaded keeps the downloaded original in the backup folder when
// --keep-backup is set; otherwise the temp file is simply discarded.
func (p *Processor) retireDownloaded(dl *downloader.Result) {
	if !p.cfg.KeepBackup {
		return
	}
	backupDir := filepath.Join(filepath.Dir(dl.TempPath), p.cfg.BackupDir)
	if err := os.MkdirAll(backupDir, dirPerm); err != nil {
		p.rep.Warn("Cannot create backup folder %s: %v", backupDir, err)
		return
	}
	if _, err := fsutil.CommitUnique(dl.TempPath, backupDir, dl.BaseName, dl.Kind.Ext()); err != nil {
		p.rep.Warn("Cannot back up original of %s: %v", dl.URL, err)
	}
}

func (p *Processor) reportOptimized(name string, res *optimizer.Result) {
	if !res.Improved() {
		p.describeKept(name, res)
		return
	}
	p.rep.Info("   ✨ Compressed -> %s (%s -> %s, -%.1f%%, %s)", name,
		report.FormatHumanBytes(res.OriginalSize), report.FormatHumanBytes(res.FinalSize), res.SavingsPercent(), res.Encoder)
}

// collectRemoteUpdates maps each note's URLs to paths relative to the note.
func (p *Processor) collectRemoteUpdates(jobs []*remoteJob) {
	for _, job := range jobs {
		if job.err != nil || job.finalPath == "" {
			continue
		}
		for _, n := range job.notes {
			rel, err := filepath.Rel(n.dir, job.finalPath)
			if err != nil {
				continue
			}
			if n.remoteUpdates == nil {
				n.remoteUpdates = make(map[string]string)
			}
			n.remoteUpdates[job.url] = filepath.ToSlash(rel)
		}
	}
}
