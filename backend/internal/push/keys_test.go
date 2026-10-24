package push

import (
	"testing"
)

// the subscription keys of RFC 8291 appendix A
const (
	rfcP256dh = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"
	rfcAuth   = "BTBZMqHH6r4Tts7J_aSIgg"
)

func TestValidKeys(t *testing.T) {
	if err := ValidKeys(rfcP256dh, rfcAuth); err != nil {
		t.Fatalf("RFC 8291 keys refused: %v", err)
	}
	for _, c := range []struct{ name, p256dh, auth string }{
		{"garbage p256dh", "not-a-key", rfcAuth},
		{"p256dh not on the curve", "BAAA" + rfcP256dh[4:], rfcAuth},
		{"short p256dh", rfcP256dh[:40], rfcAuth},
		{"short auth", rfcP256dh, "BTBZMqHH6r4"},
		{"undecodable auth", rfcP256dh, "!!!"},
	} {
		if err := ValidKeys(c.p256dh, c.auth); err == nil {
			t.Errorf("%s accepted", c.name)
		}
	}
}

// A stored subscription whose keys can never be encrypted for is dropped on
// the next notification instead of failing (with a warning) on every one.
func TestNotifyDropsSubscriptionWithUnusableKeys(t *testing.T) {
	d := vapidTestDB(t)
	s, err := New(d)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := d.Exec(`INSERT INTO users (id, email, password_hash) VALUES (1, 'one@example.com', '')`); err != nil {
		t.Fatal(err)
	}
	if err := s.Subscribe(1, "https://push.example.net/a", "garbage", "garbage", ""); err != nil {
		t.Fatal(err)
	}
	s.Notify(1, Notification{Title: "x"})
	var n int
	if err := d.QueryRow(`SELECT COUNT(*) FROM push_subscriptions`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("subscription with unusable keys kept (%d rows)", n)
	}
}
