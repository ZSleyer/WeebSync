package api

import (
	"bytes"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/ch4d1/weebsync/internal/plex"
)

// A refused stream selection (a token without write access, Plex rejecting
// allParts) used to vanish: every episode retried silently until the give-up
// window closed, and the log never named a cause. It is an error now, and it
// is logged with Plex's answer.
func TestApplyStreamsReportsPlexFailures(t *testing.T) {
	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))
	t.Cleanup(func() { slog.SetDefault(prev) })

	putStatus, getStatus := http.StatusForbidden, http.StatusOK
	partBody := `{"MediaContainer":{"Metadata":[{"ratingKey":"55","Media":[{"Part":[{"id":9,"file":"/a/e01.mkv",
		"Stream":[{"id":1,"streamType":2,"languageCode":"jpn"},{"id":2,"streamType":3,"languageCode":"deu"}]}]}]}]}}`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPut && strings.HasPrefix(r.URL.Path, "/library/parts/9"):
			w.WriteHeader(putStatus)
		case strings.HasPrefix(r.URL.Path, "/library/metadata/55"):
			w.WriteHeader(getStatus)
			w.Write([]byte(partBody))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	c := plex.New(srv.URL, "tok")
	part := plex.EpisodePart{RatingKey: "55", PartID: 9}

	// the selection itself is refused
	if _, err := applyStreams(c, part, "Jap", "Ger"); err == nil || !strings.Contains(err.Error(), "403") {
		t.Errorf("refused PUT: err = %v, want Plex's 403", err)
	}
	if !strings.Contains(buf.String(), "403") || !strings.Contains(buf.String(), "plex stream selection failed") {
		t.Errorf("the refusal was not logged with its cause: %s", buf.String())
	}

	// the streams cannot be read
	buf.Reset()
	getStatus = http.StatusUnauthorized
	if _, err := applyStreams(c, part, "Jap", "Ger"); err == nil || !strings.Contains(err.Error(), "401") {
		t.Errorf("unreadable streams: err = %v, want Plex's 401", err)
	}
	if !strings.Contains(buf.String(), "401") {
		t.Errorf("the failed read was not logged: %s", buf.String())
	}

	// Plex still analysing the file is no failure, just not yet
	buf.Reset()
	getStatus, partBody = http.StatusOK, `{"MediaContainer":{"Metadata":[]}}`
	if _, err := applyStreams(c, part, "Jap", "Ger"); !errors.Is(err, errStreamsNotReady) {
		t.Errorf("mid-analysis: err = %v, want errStreamsNotReady", err)
	}
	if buf.Len() != 0 {
		t.Errorf("a file still being analysed was logged as a failure: %s", buf.String())
	}

	// and a selection Plex takes
	putStatus, partBody = http.StatusOK, `{"MediaContainer":{"Metadata":[{"ratingKey":"55","Media":[{"Part":[{"id":9,
		"Stream":[{"id":1,"streamType":2,"languageCode":"jpn"},{"id":2,"streamType":3,"languageCode":"deu"}]}]}]}]}}`
	if miss, err := applyStreams(c, part, "Jap", "Ger"); err != nil || miss != "" {
		t.Errorf("working selection: miss %q, err %v", miss, err)
	}
}
