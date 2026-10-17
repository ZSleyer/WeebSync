package tmdb

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/dbtest"
)

func TestTransportErrorHidesAPIKey(t *testing.T) {
	d := dbtest.Open(t)
	const key = "0123456789abcdef0123456789abcdef" // v3 key: travels as api_key
	db.SetSetting(d, "tmdb_api_key", key)
	srv := httptest.NewServer(http.NotFoundHandler())
	c := New(d)
	c.BaseURL = srv.URL
	srv.Close() // nothing listens any more: the transport fails

	_, err := c.Search(context.Background(), "tv", "x", 0)
	if err == nil {
		t.Fatal("expected a transport error")
	}
	if strings.Contains(err.Error(), key) {
		t.Errorf("error leaks the API key: %v", err)
	}
	if !strings.Contains(err.Error(), "REDACTED") {
		t.Errorf("error = %v, want the redaction marker", err)
	}
}

func TestRedactURL(t *testing.T) {
	got := redactURL("https://api.example.com/3/tv/1?api_key=SECRET&language=de&session_id=SESS")
	if strings.Contains(got, "SECRET") || strings.Contains(got, "SESS") || !strings.Contains(got, "language=de") {
		t.Errorf("redactURL = %q", got)
	}
}
