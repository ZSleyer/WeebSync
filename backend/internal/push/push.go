// Package push sends Web-Push notifications (VAPID). Keys are generated
// once and stored in the settings table.
package push

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/netguard"
	"github.com/ch4d1/weebsync/internal/secret"
)

type Service struct {
	DB      *sql.DB
	public  string
	private string
}

var ErrEndpointOwned = errors.New("push endpoint belongs to another user")

// New loads the instance's VAPID key pair, generating one only when none is
// stored. Every browser subscription is bound to the stored public key, so a
// key that cannot be read or decrypted fails here instead of being replaced:
// a new pair would silently orphan every existing subscription.
func New(d *sql.DB) (*Service, error) {
	pub, err := db.SettingErr(d, "vapid_public")
	if err != nil {
		return nil, fmt.Errorf("read vapid_public: %w", err)
	}
	rawPriv, err := db.SettingErr(d, "vapid_private")
	if err != nil {
		return nil, fmt.Errorf("read vapid_private: %w", err)
	}
	var priv string
	if rawPriv != "" {
		if priv = secret.SettingOrEnv(d, "vapid_private", ""); priv == "" {
			return nil, errors.New("vapid_private is stored but cannot be decrypted (secret key changed?)")
		}
	}
	if pub != "" && priv != "" {
		return &Service{DB: d, public: pub, private: priv}, nil
	}
	if pub != "" || priv != "" {
		// half a pair signs for nobody: subscriptions made against it are
		// already dead, a new pair is the only way back
		slog.Warn("push: incomplete VAPID key pair stored, generating a new one")
	}
	priv, pub, err = generateKeys()
	if err != nil {
		return nil, err
	}
	enc, err := secret.EncodeSetting(priv)
	if err != nil {
		return nil, err
	}
	err = db.Tx(d, func(tx *sql.Tx) error {
		if err := db.SetSetting(tx, "vapid_public", pub); err != nil {
			return err
		}
		return db.SetSetting(tx, "vapid_private", enc)
	})
	if err != nil {
		return nil, err
	}
	return &Service{DB: d, public: pub, private: priv}, nil
}

func (s *Service) PublicKey() string { return s.public }

// subscriber is the VAPID "sub" claim: a way to reach whoever runs this
// instance. Apple's push service answers 403 BadJwtToken to an address that
// is not a real one, so: the configured contact, else the SMTP sender, else
// the instance's own https address (RFC 8292 takes an https URL as well).
func (s *Service) subscriber() string {
	for _, key := range []string{"push_subscriber", "smtp_from"} {
		if v := strings.TrimSpace(db.Setting(s.DB, key)); v != "" {
			if !strings.HasPrefix(v, "mailto:") && !strings.HasPrefix(v, "https:") {
				v = "mailto:" + v
			}
			return v
		}
	}
	if base := strings.TrimSpace(db.SettingOrEnv(s.DB, "base_url", "WEEBSYNC_BASE_URL")); strings.HasPrefix(base, "https://") {
		return strings.TrimRight(base, "/")
	}
	// ponytail: only Apple refuses this, and only an instance with neither
	// SMTP nor an https base URL sends it - one reached over plain http,
	// where browsers offer push on localhost alone
	return "mailto:weebsync@localhost"
}

func (s *Service) Subscribe(userID int64, endpoint, p256dh, auth string) error {
	res, err := s.DB.Exec(`INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth
		WHERE push_subscriptions.user_id = excluded.user_id`, endpoint, userID, p256dh, auth)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err == nil && n == 0 {
		return ErrEndpointOwned
	}
	return err
}

func (s *Service) Unsubscribe(userID int64, endpoint string) error {
	_, err := s.DB.Exec(`DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?`, endpoint, userID)
	return err
}

// endpointHost keeps the push service out of the log without the endpoint
// itself - the path carries the subscription secret.
func endpointHost(endpoint string) string {
	if u, err := url.Parse(endpoint); err == nil {
		return u.Hostname()
	}
	return "?"
}

// oneLine strips CR/LF so a push service's response body cannot forge log
// lines.
func oneLine(s string) string {
	return strings.NewReplacer("\r", " ", "\n", " ").Replace(strings.TrimSpace(s))
}

// Notification is what the service worker renders. Tag lets the browser
// replace an earlier notification of the same kind instead of stacking them,
// URL is where a click lands (the app root when empty).
type Notification struct {
	Title string `json:"title"`
	Body  string `json:"body"`
	Tag   string `json:"tag,omitempty"`
	URL   string `json:"url,omitempty"`
	// Icon is an https image shown beside the text (a series cover).
	Icon string `json:"icon,omitempty"`
	// Timestamp is when the event happened, in unix milliseconds.
	Timestamp int64 `json:"timestamp,omitempty"`
	// Actions are the buttons under the notification; browsers show two at
	// most. The service worker maps an action to a link in Data.
	Actions []Action `json:"actions,omitempty"`
	// Data holds per-action targets: "url" (a click), "play" (a link to open)
	// and "retry" (an API path the worker POSTs).
	Data map[string]string `json:"data,omitempty"`
	// Urgency is the RFC 8030 header ("low", "normal", ...); it travels beside
	// the payload, not in it. Empty sends none.
	Urgency string `json:"-"`
}

// Action is one button on a notification.
type Action struct {
	Action string `json:"action"`
	Title  string `json:"title"`
}

// Notify sends a notification to all of the user's subscriptions; dead
// subscriptions (404/410) are pruned.
func (s *Service) Notify(userID int64, n Notification) {
	rows, err := s.DB.Query(`SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?`, userID)
	if err != nil {
		return
	}
	defer rows.Close()
	type sub struct{ endpoint, p256dh, auth string }
	var subs []sub
	for rows.Next() {
		var x sub
		if rows.Scan(&x.endpoint, &x.p256dh, &x.auth) == nil {
			subs = append(subs, x)
		}
	}
	if err := rows.Err(); err != nil {
		// sending to the subscriptions read so far would leave the rest
		// silently without the notification: say so instead
		slog.Warn("push subscriptions read failed", "err", err)
	}

	payload, _ := json.Marshal(n)
	var targets []sub
	for _, x := range subs {
		u, err := url.Parse(x.endpoint)
		if err != nil || u.Scheme != "https" || u.Hostname() == "" {
			// a malformed endpoint is dropped again on the next notification
			_, _ = s.DB.Exec(`DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?`, x.endpoint, userID)
			continue
		}
		if err := ValidKeys(x.p256dh, x.auth); err != nil {
			// keys nothing can be encrypted for fail the same way every time
			slog.Warn("push subscription dropped", "host", endpointHost(x.endpoint), "err", err)
			_, _ = s.DB.Exec(`DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?`, x.endpoint, userID)
			continue
		}
		if err := endpointAllowed(u.Hostname()); err != nil {
			slog.Warn("push endpoint blocked", "host", endpointHost(x.endpoint), "err", err)
			continue
		}
		targets = append(targets, x)
	}
	if len(targets) == 0 {
		return
	}

	// the devices are sent to side by side under one deadline: a push
	// service that accepts the connection and never answers holds neither
	// the other devices nor the caller (the test push, the sweep) for long
	ctx, cancel := context.WithTimeout(context.Background(), notifyDeadline)
	defer cancel()
	client, subscriber := pushClient(), s.subscriber()
	gone := make([]bool, len(targets))
	sem := make(chan struct{}, notifyParallel)
	var wg sync.WaitGroup
	for i, x := range targets {
		wg.Go(func() {
			sem <- struct{}{}
			defer func() { <-sem }()
			gone[i] = s.deliver(ctx, client, x.endpoint, x.p256dh, x.auth, payload, subscriber, n.Urgency)
		})
	}
	wg.Wait()
	for i, x := range targets {
		if gone[i] {
			// a gone endpoint answers 404/410 again on the next notification
			_, _ = s.DB.Exec(`DELETE FROM push_subscriptions WHERE endpoint = ?`, x.endpoint)
		}
	}
}

// notifyDeadline bounds one Notify across all of a user's subscriptions, and
// notifyParallel how many of them are sent to at once. endpointAllowed and
// pushClient are netguard's public-only guard and client: a subscription
// host that DNS-rebinds or 30x-redirects to link-local/metadata is blocked
// at dial time. Vars so tests can point Notify at local servers.
var (
	notifyDeadline  = 20 * time.Second
	endpointAllowed = netguard.PublicAllowed
	pushClient      = func() *http.Client { return netguard.PublicClient(15 * time.Second) }
)

const notifyParallel = 4

// deliver sends one push and logs the outcome; it reports whether the push
// service called the subscription gone (404/410).
func (s *Service) deliver(ctx context.Context, client *http.Client, endpoint, p256dh, auth string, payload []byte, subscriber, urgency string) bool {
	resp, err := send(ctx, client, endpoint, p256dh, auth, payload, subscriber, s.public, s.private, 3600, urgency)
	if err != nil {
		slog.Warn("push send", "host", endpointHost(endpoint), "err", err)
		return false
	}
	defer resp.Body.Close()
	// a rejected push is otherwise invisible: the browser simply stays
	// quiet, and only the push service knows why (a bad VAPID subject and
	// an oversized payload both answer 4xx, not an error)
	if resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		slog.Warn("push rejected", "status", resp.StatusCode,
			"host", endpointHost(endpoint), "body", oneLine(string(body)))
	} else {
		slog.Debug("push sent", "status", resp.StatusCode, "host", endpointHost(endpoint))
	}
	return resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusGone
}
