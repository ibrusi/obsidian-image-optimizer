package optimizer

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

// CommandRunner runs an external program. It is the seam that lets tests
// exercise encoder chains without real binaries.
type CommandRunner interface {
	Run(ctx context.Context, name string, args ...string) error
}

// maxToolOutput bounds how much tool output is quoted in error messages.
const maxToolOutput = 512

// ExecRunner runs real processes, killing them on cancellation or timeout.
type ExecRunner struct {
	Timeout time.Duration
}

// Run executes name with args and returns an error that includes the tool's
// (truncated) output when it fails.
func (r ExecRunner) Run(ctx context.Context, name string, args ...string) error {
	if r.Timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, r.Timeout)
		defer cancel()
	}

	cmd := exec.CommandContext(ctx, name, args...)
	cmd.WaitDelay = 5 * time.Second // do not hang on children that keep pipes open
	out, err := cmd.CombinedOutput()
	if err == nil {
		return nil
	}
	if ctxErr := ctx.Err(); ctxErr != nil {
		return fmt.Errorf("%w: %w", ctxErr, err)
	}
	msg := strings.TrimSpace(string(out))
	if len(msg) > maxToolOutput {
		msg = msg[:maxToolOutput] + "..."
	}
	if msg == "" {
		return err
	}
	return fmt.Errorf("%w: %s", err, msg)
}

// Toolchain holds absolute paths of the external encoders found on the
// system; an empty path means the tool is not installed.
type Toolchain struct {
	Cwebp    string
	Ffmpeg   string
	Gifsicle string
	Gif2webp string
}

// DiscoverToolchain looks the encoders up in PATH once, at startup.
func DiscoverToolchain() Toolchain {
	lookup := func(name string) string {
		p, err := exec.LookPath(name)
		if err != nil {
			return ""
		}
		return p
	}
	return Toolchain{
		Cwebp:    lookup("cwebp"),
		Ffmpeg:   lookup("ffmpeg"),
		Gifsicle: lookup("gifsicle"),
		Gif2webp: lookup("gif2webp"),
	}
}

// CanEncodeWebP reports whether any WebP encoder for still images is available.
func (t Toolchain) CanEncodeWebP() bool {
	return t.Cwebp != "" || t.Ffmpeg != ""
}
