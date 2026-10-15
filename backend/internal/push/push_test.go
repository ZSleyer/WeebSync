package push

import (
	"errors"
	"path/filepath"
	"testing"

	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/dbtest"
	"github.com/ch4d1/weebsync/internal/secret"
)

func TestSubscriptionCannotChangeOwner(t *testing.T) {
	dir := t.TempDir()
	if err := secret.Init(dir); err != nil {
		t.Fatal(err)
	}
	d := dbtest.OpenAt(t, filepath.Join(dir, "test.db"))
	s, err := New(d)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := d.Exec(`INSERT INTO users (id, email, password_hash) VALUES
		(1, 'one@example.com', ''), (2, 'two@example.com', '')`); err != nil {
		t.Fatal(err)
	}
	if err := s.Subscribe(1, "https://push.example/a", "key", "auth"); err != nil {
		t.Fatal(err)
	}
	if err := s.Subscribe(2, "https://push.example/a", "other", "other"); !errors.Is(err, ErrEndpointOwned) {
		t.Fatalf("owner transfer error = %v", err)
	}
}

// Apple's push service refuses a made-up contact with 403 BadJwtToken, so a
// fresh instance without SMTP names its own https address instead.
func TestSubscriberFallsBackToTheBaseURL(t *testing.T) {
	t.Setenv("WEEBSYNC_BASE_URL", "")
	d := dbtest.Open(t)
	s := &Service{DB: d}
	steps := []struct{ key, value, want string }{
		{"", "", "mailto:weebsync@localhost"},
		{"base_url", "http://plain.example", "mailto:weebsync@localhost"},
		{"base_url", "https://sync.example/", "https://sync.example"},
		{"smtp_from", "ops@example.com", "mailto:ops@example.com"},
		{"push_subscriber", "https://example.com/contact", "https://example.com/contact"},
	}
	for _, st := range steps {
		if st.key != "" {
			if err := db.SetSetting(d, st.key, st.value); err != nil {
				t.Fatal(err)
			}
		}
		if got := s.subscriber(); got != st.want {
			t.Errorf("after %s=%q: subscriber = %q, want %q", st.key, st.value, got, st.want)
		}
	}
}
