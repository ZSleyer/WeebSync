package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	neturl "net/url"
	"path"
	"sort"
	"strings"
	"time"

	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/netguard"
	"github.com/ch4d1/weebsync/internal/transfer"
)

// haClient posts events to the configured Home Assistant webhook. Short
// timeout: HA answers a webhook immediately, and a hung POST must never
// hold up the transfer pipeline behind OnFinished.
// netguard: the admin sets the URL, but a redirect or a rebinding host must
// not carry the POST to a metadata endpoint; the LAN stays reachable.
var haClient = netguard.Client(5 * time.Second)

// postHaWebhook fires one event at the configured webhook, fire-and-forget:
// one retry after a pause. It returns the error of a failed delivery (without
// the URL, whose webhook id is the secret); nil without a URL.
func (s *Server) postHaWebhook(payload any) error {
	url := db.Setting(s.DB, "ha_webhook_url")
	if url == "" {
		return nil
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	post := func() error {
		resp, err := haClient.Post(url, "application/json", bytes.NewReader(body))
		if err != nil {
			var ue *neturl.Error
			if errors.As(err, &ue) {
				err = ue.Err // *url.Error would print the whole URL
			}
			return err
		}
		resp.Body.Close()
		if resp.StatusCode >= 400 {
			return fmt.Errorf("status %d", resp.StatusCode)
		}
		return nil
	}
	err = post()
	if err == nil {
		return nil
	}
	select {
	case <-time.After(2 * time.Second):
	case <-s.lifetimeCtx().Done():
		return err
	}
	return post()
}

// NotifyHaDownload tells Home Assistant a download reached done or error.
// Wired into DownloadFinished next to push and email.
func (s *Server) NotifyHaDownload(d *transfer.Download) {
	event := "download_finished"
	if d.Status == "error" {
		event = "download_error"
	}
	payload := map[string]any{
		"event":     event,
		"name":      path.Base(d.RemotePath),
		"error":     d.Error,
		"errorCode": d.ErrorCode,
		"at":        time.Now().Unix(),
	}
	s.spawn(func() {
		if err := s.postHaWebhook(payload); err != nil {
			slog.Warn("ha webhook failed", "err", err)
		}
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
// differs from last, and returns the current fingerprint. A failed post
// returns last, so the next tick tries again.
func (s *Server) haAttentionPost(last string) string {
	reasons, needy, _, err := s.statusAttention()
	if err != nil {
		// an unreadable state must not post "nothing needs attention"
		slog.Warn("ha webhook: reading attention failed", "err", err)
		return last
	}
	parts := make([]string, 0, len(needy))
	for _, n := range needy {
		parts = append(parts, fmt.Sprintf("%d:%s", n.ID, strings.Join(n.Reasons, "+")))
	}
	sort.Strings(parts)
	fp := strings.Join(parts, ",")
	if fp == last {
		return fp
	}
	if err := s.postHaWebhook(map[string]any{
		"event":   "attention_changed",
		"count":   len(needy),
		"reasons": reasons,
		"watches": needy,
		"at":      time.Now().Unix(),
	}); err != nil {
		slog.Warn("ha webhook failed", "err", err)
		return last
	}
	return fp
}
