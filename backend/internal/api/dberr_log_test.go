package api

import (
	"bytes"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// A database failure answered with a bare "db error" has to leave its cause
// in the log: the client gets nothing more, so the log is all the operator has.
func TestDbErrLogsTheCause(t *testing.T) {
	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))
	t.Cleanup(func() { slog.SetDefault(prev) })

	rec := httptest.NewRecorder()
	dbErr(rec, errors.New("database is locked"))
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("status %d, want 500", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "locked") {
		t.Errorf("the driver's message reached the client: %s", rec.Body)
	}
	if !strings.Contains(buf.String(), "database is locked") {
		t.Errorf("the cause is not in the log: %q", buf.String())
	}
}
