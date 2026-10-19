package api

import (
	"testing"
	"time"

	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/dbtest"
	"github.com/ch4d1/weebsync/internal/plex"
)

// An empty plan says why, so the UI can show the button disabled with the
// reason instead of hiding it.
func TestSyncPlanMissingReason(t *testing.T) {
	if p := existingSyncPlan(syncNaming{}, "plex:123:s3", 3, false); p.Missing != planMissingUnmapped {
		t.Fatalf("media server key: %+v", p)
	}
	if p := existingSyncPlan(syncNaming{}, "", 3, false); p.Missing != planMissingNoFolder {
		t.Fatalf("unknown folder: %+v", p)
	}
	if p := missingSyncPlan(syncNaming{}, "", 2, false); p.Missing != planMissingNoSibling {
		t.Fatalf("no sibling: %+v", p)
	}
	if p := existingSyncPlan(syncNaming{}, "/media/Show/Season 01", 1, false); p.Missing != "" {
		t.Fatalf("usable plan carries a reason: %+v", p)
	}
}

func TestPlanNotesExplain(t *testing.T) {
	folder := "plex:9:s1"
	notes := map[string]plexPathNote{
		folder:      {Path: "/data/anime/Show/Season 01"},
		"plex:8:s1": {Path: "/x", Mapped: true},
	}
	plan := existingSyncPlan(syncNaming{}, folder, 1, false)

	got := planNotes{m: notes, admin: true}.explain(plan, folder)
	if got.Missing != planMissingUnmapped || got.ServerPath != "/data/anime/Show/Season 01" {
		t.Fatalf("admin: %+v", got)
	}
	// the path is infrastructure detail: a non-admin gets the reason only
	if got := (planNotes{m: notes}).explain(plan, folder); got.ServerPath != "" || got.Missing != planMissingUnmapped {
		t.Fatalf("non-admin: %+v", got)
	}
	// a mapping that applies but points nowhere is another problem
	got = planNotes{m: notes, admin: true}.explain(existingSyncPlan(syncNaming{}, "plex:8:s1", 1, false), "plex:8:s1")
	if got.Missing != planMissingNotFound {
		t.Fatalf("mapped: %+v", got)
	}
	// no note recorded: the reason stays, the path is unknown
	if got := (planNotes{admin: true}).explain(plan, folder); got.Missing != planMissingUnmapped || got.ServerPath != "" {
		t.Fatalf("no note: %+v", got)
	}
}

// The index remembers the folder a media server reports for a copy it cannot
// reach, and whether a mapping already applied to it.
func TestPlexLocalQualityNotesUnreachablePath(t *testing.T) {
	d := dbtest.Open(t)
	s := testServer(t, &Server{DB: d})

	_, folder, note := s.plexLocalQuality(plex.ShowMedia{File: "/data/anime/Show/Season 01/e01.mkv", ResHeight: 1080}, "42", 1)
	if folder != "plex:42:s1" || note == nil || note.Path != "/data/anime/Show/Season 01" || note.Mapped {
		t.Fatalf("unmapped: folder=%q note=%+v", folder, note)
	}

	db.SetSetting(d, "plex_roots", "/data/anime => /nonexistent/anime")
	_, _, note = s.plexLocalQuality(plex.ShowMedia{File: "/data/anime/Show/Season 01/e01.mkv"}, "42", 1)
	if note == nil || !note.Mapped {
		t.Fatalf("mapped but missing: %+v", note)
	}

	// no path at all from the server: nothing to report
	if _, _, note := s.plexLocalQuality(plex.ShowMedia{}, "42", 1); note != nil {
		t.Fatalf("no file: %+v", note)
	}

	s.storePlexPathNotes(map[string]plexPathNote{"plex:42:s1": {Path: "/data/anime/Show/Season 01"}})
	if _, ok := s.cacheGet(plexPathNotesKey, time.Hour); !ok {
		t.Fatal("notes not stored")
	}
}
