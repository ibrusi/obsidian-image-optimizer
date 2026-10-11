package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"
	"time"

	"obsidian-image-optimizer/pkg/config"
	"obsidian-image-optimizer/pkg/downloader"
	"obsidian-image-optimizer/pkg/optimizer"
	"obsidian-image-optimizer/pkg/processor"
	"obsidian-image-optimizer/pkg/report"
)

// Exit codes.
const (
	exitOK          = 0
	exitFatal       = 1
	exitPartial     = 2 // finished, but some images or notes failed
	exitInterrupted = 130
)

func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	code := run(ctx, os.Args[1:], os.Stdout, os.Stderr)
	cancel()
	os.Exit(code)
}

func run(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	cfg, err := config.Parse(args, stderr)
	if errors.Is(err, flag.ErrHelp) {
		return exitOK
	}
	if err != nil {
		fmt.Fprintf(stderr, "Configuration error: %v\n", err)
		return exitFatal
	}

	rep := report.New(cfg.Output, cfg.Verbose, stdout, stderr)

	tools := optimizer.DiscoverToolchain()
	if !tools.CanEncodeWebP() {
		rep.Warn("Neither cwebp nor ffmpeg was found in PATH: JPEG/PNG images cannot be converted to WebP. Install the 'webp' package.")
	}

	dl := downloader.New(downloader.Options{
		Timeout:           time.Duration(cfg.TimeoutSeconds) * time.Second,
		UserAgent:         cfg.UserAgent,
		MaxBytes:          cfg.MaxDownloadBytes(),
		AllowPrivateHosts: cfg.AllowPrivateHosts,
	})
	runner := optimizer.ExecRunner{Timeout: time.Duration(cfg.ToolTimeoutSeconds) * time.Second}
	opt := optimizer.New(tools, runner, optimizer.OptionsFromConfig(cfg))

	proc := processor.New(cfg, rep, dl, opt)
	if err := proc.Run(ctx); err != nil {
		if errors.Is(err, context.Canceled) {
			fmt.Fprintln(stderr, "Process interrupted by user.")
			return exitInterrupted
		}
		fmt.Fprintf(stderr, "Execution error: %v\n", err)
		return exitFatal
	}

	if proc.Stats().Errors > 0 {
		return exitPartial
	}
	return exitOK
}
