package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"obsidian-image-optimizer/pkg/config"
	"obsidian-image-optimizer/pkg/processor"
)

func main() {
	cfg, err := config.ParseFlags()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Configuration error: %v\n", err)
		os.Exit(1)
	}

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	proc := processor.NewProcessor(cfg)

	if err := proc.Run(ctx); err != nil {
		if err == context.Canceled {
			fmt.Println("\nProcess interrupted by user.")
			os.Exit(130)
		}
		fmt.Fprintf(os.Stderr, "Execution error: %v\n", err)
		os.Exit(1)
	}

	stats := proc.Stats()
	if stats.TotalErrors > 0 && stats.TotalFilesModified == 0 {
		os.Exit(1)
	}
}
