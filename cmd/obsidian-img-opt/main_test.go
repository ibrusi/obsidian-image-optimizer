package main

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRunExitCodes(t *testing.T) {
	vault := t.TempDir()
	if err := os.WriteFile(filepath.Join(vault, "note.md"), []byte("# empty\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	tests := []struct {
		name string
		args []string
		want int
	}{
		{"help", []string{"-h"}, exitOK},
		{"invalid flag value", []string{"--vault", vault, "--quality", "0"}, exitFatal},
		{"unknown flag", []string{"--no-such-flag"}, exitFatal},
		{"missing vault", []string{"--vault", filepath.Join(vault, "missing")}, exitFatal},
		{"ok", []string{"--vault", vault}, exitOK},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var stdout, stderr bytes.Buffer
			if got := run(context.Background(), tt.args, &stdout, &stderr); got != tt.want {
				t.Errorf("exit code %d, want %d\nstdout: %s\nstderr: %s", got, tt.want, stdout.String(), stderr.String())
			}
		})
	}
}

func TestRunPartialFailureAndJSON(t *testing.T) {
	vault := t.TempDir()
	note := "![x](http://127.0.0.1:1/unreachable.png)\n"
	if err := os.WriteFile(filepath.Join(vault, "note.md"), []byte(note), 0o644); err != nil {
		t.Fatal(err)
	}

	var stdout, stderr bytes.Buffer
	code := run(context.Background(), []string{"--vault", vault, "--output", "json"}, &stdout, &stderr)
	if code != exitPartial {
		t.Fatalf("exit code %d, want %d\nstderr: %s", code, exitPartial, stderr.String())
	}

	var doc struct {
		Schema   int      `json:"schema"`
		Errors   int      `json:"errors"`
		Warnings []string `json:"warnings"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &doc); err != nil {
		t.Fatalf("invalid JSON on stdout: %v\n%s", err, stdout.String())
	}
	if doc.Schema != 1 || doc.Errors != 1 || len(doc.Warnings) == 0 {
		t.Errorf("unexpected summary %+v", doc)
	}
	if !strings.Contains(doc.Warnings[0], "private") {
		t.Errorf("loopback URL must be blocked by SSRF protection, got %q", doc.Warnings[0])
	}
}

func TestRunInterrupted(t *testing.T) {
	vault := t.TempDir()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	var stdout, stderr bytes.Buffer
	if got := run(ctx, []string{"--vault", vault}, &stdout, &stderr); got != exitInterrupted {
		t.Errorf("exit code %d, want %d", got, exitInterrupted)
	}
}
