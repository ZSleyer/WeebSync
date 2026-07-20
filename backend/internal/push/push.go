// Package push sends Web-Push notifications (VAPID). Keys are generated
// once and stored in the settings table.
package push

import (
	"database/sql"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"

	"github.com/SherClockHolmes/webpush-go"
	"github.com/ch4d1/weebsync/internal/db"
)

type Service struct {
	DB      *sql.DB
	public  string
	private string
}

func New(d *sql.DB) (*Service, error) {
	pub := db.Setting(d, "vapid_public")
	priv := db.Setting(d, "vapid_private")
	if pub == "" || priv == "" {
		var err error
		priv, pub, err = webpush.GenerateVAPIDKeys()
		if err != nil {
			return nil, err
		}
		db.SetSetting(d, "vapid_public", pub)
		db.SetSetting(d, "vapid_private", priv)
	}
	return &Service{DB: d, public: pub, private: priv}, nil
}

func (s *Service) PublicKey() string { return s.public }

// subscriber is the VAPID "sub" claim: a way to reach whoever runs this
// instance. Some push services (Apple's in particular) reject a token whose
// address is not a real one, so prefer the configured SMTP sender.
func (s *Service) subscriber() string {
	for _, key := range []string{"push_subscriber", "smtp_from"} {
		if v := strings.TrimSpace(db.Setting(s.DB, key)); v != "" {
			if !strings.HasPrefix(v, "mailto:") && !strings.HasPrefix(v, "https:") {
				v = "mailto:" + v
			}
			return v
		}
	}
	return "mailto:weebsync@localhost"
}

func (s *Service) Subscribe(userID int64, endpoint, p256dh, auth string) error {
	_, err := s.DB.Exec(`INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id,
			p256dh = excluded.p256dh, auth = excluded.auth`, endpoint, userID, p256dh, auth)
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
}

// Notify sends a notification to all of the user's subscriptions; dead
// subscriptions (404/410) are pruned.
func (s *Service) Notify(userID int64, n Notification) {
	rows, err := s.DB.Query(`SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?`, userID)
	if err != nil {
		return
	}
	type sub struct{ endpoint, p256dh, auth string }
	var subs []sub
	for rows.Next() {
		var x sub
		if rows.Scan(&x.endpoint, &x.p256dh, &x.auth) == nil {
			subs = append(subs, x)
		}
	}
	rows.Close()

	payload, _ := json.Marshal(n)
	for _, x := range subs {
		resp, err := webpush.SendNotification(payload, &webpush.Subscription{
			Endpoint: x.endpoint,
			Keys:     webpush.Keys{P256dh: x.p256dh, Auth: x.auth},
		}, &webpush.Options{
			Subscriber:      s.subscriber(),
			VAPIDPublicKey:  s.public,
			VAPIDPrivateKey: s.private,
			TTL:             3600,
			// the library pads every record to 4096 bytes by default, which
			// Mozilla's endpoints reject with 413 ("intended for a constrained
			// device") - our notifications are a few hundred bytes at most
			RecordSize: 2048,
		})
		if err != nil {
			slog.Warn("push send", "err", err)
			continue
		}
		// a rejected push is otherwise invisible: the browser simply stays
		// quiet, and only the push service knows why (a bad VAPID subject and
		// an oversized payload both answer 4xx, not an error)
		if resp.StatusCode >= 300 {
			body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
			slog.Warn("push rejected", "status", resp.StatusCode,
				"host", endpointHost(x.endpoint), "body", oneLine(string(body)))
		} else {
			slog.Debug("push sent", "status", resp.StatusCode, "host", endpointHost(x.endpoint))
		}
		if resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusGone {
			s.DB.Exec(`DELETE FROM push_subscriptions WHERE endpoint = ?`, x.endpoint)
		}
		resp.Body.Close()
	}
}
