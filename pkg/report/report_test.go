package report

import (
	"bytes"
	"encoding/json"
	"strings"
	"sync"
	"testing"

	"obsidian-image-optimizer/pkg/config"
)

func TestFormatHumanBytes(t *testing.T) {
	tests := map[int64]string{
		0:          "0 B",
		1023:       "1023 B",
		1024:       "1.00 KB",
		1536:       "1.50 KB",
		1048576:    "1.00 MB",
		-2048:      "-2.00 KB",
		1073741824: "1.00 GB",
	}
	for in, want := range tests {
		if got := FormatHumanBytes(in); got != want {
			t.Errorf("FormatHumanBytes(%d) = %q, want %q", in, got, want)
		}
	}
}

func TestTextSummary(t *testing.T) {
	var out bytes.Buffer
	r := New(config.OutputText, false, &out, &bytes.Buffer{})
	r.Debug("hidden unless verbose")
	r.Summary(Summary{FilesScanned: 2, ImagesCompressed: 1, OriginalBytes: 2048, OptimizedBytes: 1024, Errors: 1})

	text := out.String()
	for _, want := range []string{"Optimization Complete", "Total space saved:         1.00 KB (-50.0%)", "Errors encountered:        1"} {
		if !strings.Contains(text, want) {
			t.Errorf("summary misses %q:\n%s", want, text)
		}
	}
	if strings.Contains(text, "hidden unless verbose") {
		t.Error("debug output printed without --verbose")
	}
}

func TestJSONSummary(t *testing.T) {
	var stdout, stderr bytes.Buffer
	r := New(config.OutputJSON, false, &stdout, &stderr)

	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r.Info("progress")
			r.Warn("problem %d", 1)
		}()
	}
	wg.Wait()
	r.Summary(Summary{FilesScanned: 3, FilesModified: 1, OriginalBytes: 4096, OptimizedBytes: 1024, Errors: 2})

	var doc map[string]any
	if err := json.Unmarshal(stdout.Bytes(), &doc); err != nil {
		t.Fatalf("stdout must contain only the JSON summary: %v\n%s", err, stdout.String())
	}
	if doc["schema"] != float64(SchemaVersion) || doc["filesModified"] != float64(1) || doc["errors"] != float64(2) {
		t.Errorf("unexpected document %v", doc)
	}
	if doc["savedHuman"] != "3.00 KB" || doc["savedPercent"] != float64(75) {
		t.Errorf("unexpected savings %v / %v", doc["savedHuman"], doc["savedPercent"])
	}
	if warnings, ok := doc["warnings"].([]any); !ok || len(warnings) != 10 {
		t.Errorf("expected 10 warnings, got %v", doc["warnings"])
	}
	if !strings.Contains(stderr.String(), "progress") {
		t.Error("progress must go to stderr in JSON mode")
	}
}
