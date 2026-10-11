// Package report renders progress messages and the final summary, either as
// human-readable text or as a single JSON document for integrations such as
// the Obsidian plugin. All reporters are safe for concurrent use.
package report

import (
	"encoding/json"
	"fmt"
	"io"
	"sync"

	"obsidian-image-optimizer/pkg/config"
)

// SchemaVersion is the version of the JSON summary format.
const SchemaVersion = 1

// maxJSONWarnings bounds the warnings embedded in the JSON summary.
const maxJSONWarnings = 100

// Summary contains the metrics of an optimisation run.
type Summary struct {
	Schema      int  `json:"schema"`
	DryRun      bool `json:"dryRun"`
	Interrupted bool `json:"interrupted"`

	FilesScanned  int `json:"filesScanned"`
	FilesModified int `json:"filesModified"`

	ImagesFound      int `json:"imagesFound"`
	ImagesCompressed int `json:"imagesCompressed"`
	OriginalsKept    int `json:"originalsKept"`
	// OriginalsStillReferenced counts optimised local images whose original
	// was left in place because something else in the vault may use it.
	OriginalsStillReferenced int `json:"originalsStillReferenced"`
	Errors                   int `json:"errors"`

	OriginalBytes  int64 `json:"originalBytes"`
	OptimizedBytes int64 `json:"optimizedBytes"`

	PlannedDownloads int `json:"plannedDownloads,omitempty"`
	PlannedLocal     int `json:"plannedLocal,omitempty"`
}

// SavedBytes is the total size reduction.
func (s Summary) SavedBytes() int64 { return s.OriginalBytes - s.OptimizedBytes }

// SavedPercent is the relative total size reduction.
func (s Summary) SavedPercent() float64 {
	if s.OriginalBytes == 0 {
		return 0
	}
	return float64(s.SavedBytes()) / float64(s.OriginalBytes) * 100
}

// Reporter receives progress messages and the final summary.
type Reporter interface {
	// Info reports regular progress.
	Info(format string, args ...any)
	// Warn reports a problem that did not stop the run.
	Warn(format string, args ...any)
	// Debug reports details shown only in verbose mode.
	Debug(format string, args ...any)
	// Summary reports the final result; called once at the end.
	Summary(s Summary)
}

// New returns the reporter for the configured output format. Text goes to
// stdout; in JSON mode stdout carries only the summary document and progress
// lines go to stderr.
func New(format config.OutputFormat, verbose bool, stdout, stderr io.Writer) Reporter {
	if format == config.OutputJSON {
		return &JSONReporter{out: stdout, log: &TextReporter{out: stderr, verbose: verbose}}
	}
	return &TextReporter{out: stdout, verbose: verbose}
}

// TextReporter prints human-readable lines.
type TextReporter struct {
	mu      sync.Mutex
	out     io.Writer
	verbose bool
}

// NewText returns a text reporter writing to out.
func NewText(out io.Writer, verbose bool) *TextReporter {
	return &TextReporter{out: out, verbose: verbose}
}

func (r *TextReporter) Info(format string, args ...any) { r.println(format, args...) }

func (r *TextReporter) Warn(format string, args ...any) { r.println("⚠️  "+format, args...) }

func (r *TextReporter) Debug(format string, args ...any) {
	if r.verbose {
		r.println(format, args...)
	}
}

func (r *TextReporter) println(format string, args ...any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	fmt.Fprintf(r.out, format+"\n", args...)
}

func (r *TextReporter) Summary(s Summary) {
	r.mu.Lock()
	defer r.mu.Unlock()
	w := r.out

	fmt.Fprintf(w, "\n==========================================\n")
	switch {
	case s.Interrupted:
		fmt.Fprintf(w, "⏹️  Optimization interrupted\n")
	case s.DryRun:
		fmt.Fprintf(w, "🔎 Dry run: nothing was changed\n")
	default:
		fmt.Fprintf(w, "🎉 Optimization Complete!\n")
	}
	fmt.Fprintf(w, "==========================================\n")
	fmt.Fprintf(w, "📄 Files scanned:             %d\n", s.FilesScanned)
	if s.DryRun {
		fmt.Fprintf(w, "⬇️  Remote images to fetch:    %d\n", s.PlannedDownloads)
		fmt.Fprintf(w, "📁 Local images to optimize:  %d\n", s.PlannedLocal)
	} else {
		fmt.Fprintf(w, "✏️  Files updated:             %d\n", s.FilesModified)
		fmt.Fprintf(w, "🖼️  Images processed:          %d\n", s.ImagesFound)
		fmt.Fprintf(w, "✨ Images compressed:         %d\n", s.ImagesCompressed)
		fmt.Fprintf(w, "📦 Originals kept (smaller):  %d\n", s.OriginalsKept)
		if s.OriginalsStillReferenced > 0 {
			fmt.Fprintf(w, "🔗 Originals still in use:    %d\n", s.OriginalsStillReferenced)
		}
	}
	if s.Errors > 0 {
		fmt.Fprintf(w, "⚠️  Errors encountered:        %d\n", s.Errors)
	}
	if s.OriginalBytes > 0 {
		fmt.Fprintf(w, "📊 Original total size:       %s\n", FormatHumanBytes(s.OriginalBytes))
		fmt.Fprintf(w, "💾 Optimized total size:      %s\n", FormatHumanBytes(s.OptimizedBytes))
		fmt.Fprintf(w, "🚀 Total space saved:         %s (-%.1f%%)\n", FormatHumanBytes(s.SavedBytes()), s.SavedPercent())
	}
	fmt.Fprintf(w, "==========================================\n\n")
}

// JSONReporter forwards progress to a text log and prints the summary as JSON.
type JSONReporter struct {
	mu       sync.Mutex
	out      io.Writer
	log      *TextReporter
	warnings []string
}

func (r *JSONReporter) Info(format string, args ...any) { r.log.Info(format, args...) }

func (r *JSONReporter) Debug(format string, args ...any) { r.log.Debug(format, args...) }

func (r *JSONReporter) Warn(format string, args ...any) {
	r.log.Warn(format, args...)
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.warnings) < maxJSONWarnings {
		r.warnings = append(r.warnings, fmt.Sprintf(format, args...))
	}
}

func (r *JSONReporter) Summary(s Summary) {
	r.mu.Lock()
	defer r.mu.Unlock()

	doc := struct {
		Summary
		SavedBytes   int64    `json:"savedBytes"`
		SavedPercent float64  `json:"savedPercent"`
		SavedHuman   string   `json:"savedHuman"`
		Warnings     []string `json:"warnings"`
	}{
		Summary:      s,
		SavedBytes:   s.SavedBytes(),
		SavedPercent: s.SavedPercent(),
		SavedHuman:   FormatHumanBytes(s.SavedBytes()),
		Warnings:     append([]string{}, r.warnings...),
	}
	doc.Schema = SchemaVersion

	enc := json.NewEncoder(r.out)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(doc)
}

// FormatHumanBytes formats a byte count into a human-readable string (KB, MB).
func FormatHumanBytes(b int64) string {
	const unit = 1024
	if b < 0 {
		return "-" + FormatHumanBytes(-b)
	}
	if b < unit {
		return fmt.Sprintf("%d B", b)
	}
	div, exp := int64(unit), 0
	for n := b / unit; n >= unit; n /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.2f %cB", float64(b)/float64(div), "KMGTPE"[exp])
}
