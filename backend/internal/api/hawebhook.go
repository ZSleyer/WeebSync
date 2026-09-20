package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"path"
	"sort"
	"strings"
	"time"

	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/transfer"
)

// haClient posts events to the configured Home Assistant webhook. Short
// timeout: HA answers a webhook immediately, and a hung POST must never
// hold up the transfer pipeline behind OnFinished.
var haClient = &http.Client{Timeout: 5 * time.Second}

// postHaWebhook fires one event at the configured webhook, fire-and-forget:
// one retry after a pause, then a warning in the log. No-op without a URL.
func (s *Server) postHaWebhook(payload any) {
	url := db.Setting(s.DB, "ha_webhook_url")
	if url == "" {
		return
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return
	}
	post := func() error {
		resp, err := haClient.Post(url, "application/json", bytes.NewReader(body))
		if err != nil {
			return err
		}
		resp.Body.Close()
		if resp.StatusCode >= 400 {
			return fmt.Errorf("status %d", resp.StatusCode)
		}
		return nil
	}
	if err := post(); err != nil {
		time.Sleep(2 * time.Second)
		if err = post(); err != nil {
			slog.Warn("ha webhook failed", "err", err)
		}
	}
}

// NotifyHaDownload tells Home Assistant a download reached done or error.
// Wired into DownloadFinished next to push and email.
func (s *Server) NotifyHaDownload(d *transfer.Download) {
	event := "download_finished"
	if d.Status == "error" {
		event = "download_error"
	}
	go s.postHaWebhook(map[string]any{
		"event":     event,
		"name":      path.Base(d.RemotePath),
		"error":     d.Error,
		"errorCode": d.ErrorCode,
		"at":        time.Now().Unix(),
	})
}

// HaAttentionLoop tells Home Assistant when the needs-attention picture
// changes: once a minute it takes the same aggregate the status endpoint
// serves and posts it - only when the fingerprint moved, so a quiet
// instance stays quiet.
func (s *Server) HaAttentionLoop(ctx context.Context) {
	last := ""
	tick := time.NewTicker(time.Minute)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			if db.Setting(s.DB, "ha_webhook_url") == "" {
				continue
			}
			last = s.haAttentionPost(last)
		}
	}
}

// haAttentionPost posts the attention aggregate when its fingerprint
// differs from last, and returns the current fingerprint.
func (s *Server) haAttentionPost(last string) string {
	reasons, needy, _ := s.statusAttention()
	parts := make([]string, 0, len(needy))
	for _, n := range needy {
		parts = append(parts, fmt.Sprintf("%d:%s", n.ID, strings.Join(n.Reasons, "+")))
	}
	sort.Strings(parts)
	fp := strings.Join(parts, ",")
	if fp == last {
		return fp
	}
	s.postHaWebhook(map[string]any{
		"event":   "attention_changed",
		"count":   len(needy),
		"reasons": reasons,
		"watches": needy,
		"at":      time.Now().Unix(),
	})
	return fp
}
