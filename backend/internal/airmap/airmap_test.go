package airmap

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/ch4d1/weebsync/internal/db"
)

func TestResolveCache(t *testing.T) {
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	// seed a fresh cache so Resolve skips the (client-less) rebuild; the source
	// tag must match the series' effective provider+ordering
	d.Exec(`INSERT INTO season_maps_meta (server_id, folder, source, updated_at) VALUES (1,'Conan','tvdb:official:0',datetime('now'))`)
	d.Exec(`INSERT INTO season_maps (server_id, folder, absolute, season, episode) VALUES (1,'Conan',1187,34,1)`)

	r := &Resolver{DB: d}
	s := Series{ServerID: 1, Folder: "Conan", Provider: "tvdb", Ordering: "official"}
	if season, ep, ok := r.Resolve(context.Background(), s, 1187); !ok || season != 34 || ep != 1 {
		t.Errorf("1187 -> S%dE%d ok=%v, want S34E01", season, ep, ok)
	}
	if _, _, ok := r.Resolve(context.Background(), s, 9999); ok {
		t.Error("unknown absolute should not resolve")
	}
	if _, _, ok := r.Resolve(context.Background(), s, 0); ok {
		t.Error("absolute 0 should not resolve")
	}
}
