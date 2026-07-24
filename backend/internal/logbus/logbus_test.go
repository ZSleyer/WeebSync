package logbus

import (
	"context"
	"log/slog"
	"strings"
	"testing"
	"time"
)

func TestParseLevelRoundtrip(t *testing.T) {
	for _, name := range []string{"trace", "debug", "info", "warn", "error"} {
		if got := LevelString(ParseLevel(name)); got != name {
			t.Errorf("roundtrip %q -> %q", name, got)
		}
	}
	if ParseLevel("nonsense") != slog.LevelInfo {
		t.Error("unknown level should fall back to info")
	}
	if ParseLevel("warning") != slog.LevelWarn {
		t.Error("warning should alias warn")
	}
}

func TestRingBufferCapAndFanout(t *testing.T) {
	lvl := new(slog.LevelVar)
	lvl.Set(LevelTrace)
	b := New(lvl, 3)
	log := slog.New(b)

	ch, unsub := b.Subscribe()
	defer unsub()

	for i := 0; i < 5; i++ {
		log.Info("msg", "i", i)
	}

	// ring keeps only the last 3
	backlog := b.Backlog()
	if len(backlog) != 3 {
		t.Fatalf("backlog len = %d, want 3", len(backlog))
	}
	if !strings.Contains(backlog[2], `"i":4`) {
		t.Errorf("newest backlog line missing i=4: %s", backlog[2])
	}

	// subscriber saw all 5 live lines
	got := 0
	for got < 5 {
		select {
		case <-ch:
			got++
		case <-time.After(time.Second):
			t.Fatalf("subscriber got %d/5 lines", got)
		}
	}
}

func TestEnabledRespectsLevel(t *testing.T) {
	lvl := new(slog.LevelVar)
	lvl.Set(slog.LevelWarn)
	b := New(lvl, 10)
	if b.Enabled(context.Background(), slog.LevelInfo) {
		t.Error("info should be disabled at warn level")
	}
	if !b.Enabled(context.Background(), slog.LevelError) {
		t.Error("error should be enabled at warn level")
	}
	lvl.Set(LevelTrace)
	if !b.Enabled(context.Background(), LevelTrace) {
		t.Error("trace should be enabled after switching to trace")
	}
}
