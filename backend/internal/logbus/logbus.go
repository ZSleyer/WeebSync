// Package logbus is the app-wide slog handler: it keeps the normal stderr
// text output, adds a runtime-switchable level (incl. a custom TRACE below
// slog's DEBUG), and fans every record out as JSON to a ring buffer plus live
// SSE subscribers so an admin can watch background activity in the UI.
package logbus

import (
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"strings"
	"sync"
	"time"
)

// LevelTrace sits below slog's DEBUG (-4). slog native: DEBUG -4 / INFO 0 /
// WARN 4 / ERROR 8.
const LevelTrace = slog.Level(-8)

// ParseLevel maps a config/env string to a level; unknown falls back to INFO.
func ParseLevel(s string) slog.Level {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "trace":
		return LevelTrace
	case "debug":
		return slog.LevelDebug
	case "warn", "warning":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}

// LevelString is the inverse of ParseLevel (lower-case names the UI uses).
func LevelString(l slog.Level) string {
	switch {
	case l <= LevelTrace:
		return "trace"
	case l <= slog.LevelDebug:
		return "debug"
	case l <= slog.LevelInfo:
		return "info"
	case l <= slog.LevelWarn:
		return "warn"
	default:
		return "error"
	}
}

// Trace logs at the custom TRACE level via the default logger.
func Trace(msg string, args ...any) {
	slog.Log(context.Background(), LevelTrace, msg, args...)
}

// Bus is a slog.Handler wrapping a stderr text handler and mirroring every
// record as JSON into a shared ring buffer + SSE subscribers.
type Bus struct {
	Level *slog.LevelVar
	inner slog.Handler // text -> stderr (unchanged behaviour)
	core  *core        // shared across WithAttrs/WithGroup clones
	attrs []slog.Attr  // accumulated via WithAttrs, for the JSON mirror
}

type core struct {
	mu   sync.Mutex
	ring []string
	cap  int
	subs map[chan string]struct{}
}

type entry struct {
	Ts    string         `json:"ts"`
	Level string         `json:"level"`
	Msg   string         `json:"msg"`
	Attrs map[string]any `json:"attrs,omitempty"`
}

// New builds the bus. level is shared (a *slog.LevelVar) so the level can be
// flipped at runtime; ringCap bounds the in-memory backlog.
func New(level *slog.LevelVar, ringCap int) *Bus {
	opts := &slog.HandlerOptions{
		Level: level,
		ReplaceAttr: func(_ []string, a slog.Attr) slog.Attr {
			// print the custom TRACE level as "TRACE" instead of "DEBUG-4"
			if a.Key == slog.LevelKey {
				if lv, ok := a.Value.Any().(slog.Level); ok {
					a.Value = slog.StringValue(strings.ToUpper(LevelString(lv)))
				}
			}
			return a
		},
	}
	return &Bus{
		Level: level,
		inner: slog.NewTextHandler(os.Stderr, opts),
		core:  &core{cap: ringCap, subs: map[chan string]struct{}{}},
	}
}

func (h *Bus) Enabled(_ context.Context, l slog.Level) bool {
	return l >= h.Level.Level()
}

func (h *Bus) Handle(ctx context.Context, r slog.Record) error {
	_ = h.inner.Handle(ctx, r) // stderr text output, unchanged

	m := map[string]any{}
	for _, a := range h.attrs {
		addAttr(m, a)
	}
	r.Attrs(func(a slog.Attr) bool { addAttr(m, a); return true })

	e := entry{
		Ts:    r.Time.UTC().Format(time.RFC3339Nano),
		Level: LevelString(r.Level),
		Msg:   r.Message,
		Attrs: m,
	}
	if b, err := json.Marshal(e); err == nil {
		h.core.publish(string(b))
	}
	return nil
}

func (h *Bus) WithAttrs(as []slog.Attr) slog.Handler {
	c := *h
	c.inner = h.inner.WithAttrs(as)
	c.attrs = append(append([]slog.Attr{}, h.attrs...), as...)
	return &c
}

// ponytail: JSON mirror flattens group names into the inner text handler only;
// no call site uses WithGroup, so the JSON attrs stay flat. Add prefixing here
// if grouped logging ever lands.
func (h *Bus) WithGroup(name string) slog.Handler {
	c := *h
	c.inner = h.inner.WithGroup(name)
	return &c
}

// addAttr flattens one attr (recursing into inline groups) into m.
func addAttr(m map[string]any, a slog.Attr) {
	a.Value = a.Value.Resolve()
	if a.Value.Kind() == slog.KindGroup {
		for _, ga := range a.Value.Group() {
			addAttr(m, ga)
		}
		return
	}
	if a.Key == "" {
		return
	}
	m[a.Key] = a.Value.Any()
}

// ── SSE fan-out (mirrors transfer.Manager) ──────────────────

// Subscribe returns a live channel of JSON log lines and an unsubscribe func.
func (h *Bus) Subscribe() (<-chan string, func()) {
	ch := make(chan string, 256)
	h.core.mu.Lock()
	h.core.subs[ch] = struct{}{}
	h.core.mu.Unlock()
	return ch, func() {
		h.core.mu.Lock()
		delete(h.core.subs, ch)
		h.core.mu.Unlock()
	}
}

// Backlog returns a copy of the buffered recent log lines (oldest first).
func (h *Bus) Backlog() []string {
	h.core.mu.Lock()
	defer h.core.mu.Unlock()
	return append([]string(nil), h.core.ring...)
}

func (c *core) publish(msg string) {
	c.mu.Lock()
	c.ring = append(c.ring, msg)
	if len(c.ring) > c.cap {
		c.ring = c.ring[len(c.ring)-c.cap:]
	}
	for ch := range c.subs {
		select {
		case ch <- msg:
		default: // slow subscriber: drop rather than block logging
		}
	}
	c.mu.Unlock()
}
