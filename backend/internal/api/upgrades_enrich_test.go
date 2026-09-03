package api

import (
	"encoding/json"
	"testing"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/tmdb"
)

func cacheMedia(t *testing.T, s *Server, key string, id int, title, cover string) {
	t.Helper()
	m := anilist.Media{ID: id, Status: "FINISHED", Schema: anilist.MediaSchema, Format: "TV"}
	m.Title.Romaji = title
	m.CoverImage.Large = cover
	b, _ := json.Marshal(m)
	s.cacheSet(key, string(b))
}

func TestShowKeyCanonPrefersProviderKeys(t *testing.T) {
	s, _ := sizeTestServer(t)
	s.DB.Exec(`INSERT INTO series (id, key, title) VALUES (7, 'show', 'Show')`)
	// the fold key sorts first, but the TVDB id knows more
	s.DB.Exec(`INSERT INTO catalog_variants (server_id, folder, show_key, season, series_id) VALUES (1, '/a', 'fold:show', 1, 7)`)
	s.DB.Exec(`INSERT INTO catalog_variants (server_id, folder, show_key, season, series_id) VALUES (1, '/b', 'tvdb:99', 1, 7)`)
	s.DB.Exec(`INSERT INTO catalog_variants (server_id, folder, show_key, season, series_id) VALUES (0, '/c', 'tmdb:5', 1, 7)`)
	canon := s.showKeyCanon()
	if canon["fold:show"] != "tvdb:99" || canon["tmdb:5"] != "tvdb:99" || canon["tvdb:99"] != "" {
		t.Fatalf("canon: %v", canon)
	}
	units := s.loadUnits()
	if len(units.order) != 1 || units.order[0] != "unit:tvdb:99:1" {
		t.Fatalf("units: %v", units.order)
	}
}

func TestUnitEnrichReadsTheKeyProvider(t *testing.T) {
	s, _ := sizeTestServer(t)
	s.Tmdb = tmdb.New(s.DB)
	// a Plex show keyed by its TMDB agent, matched to nothing
	s.DB.Exec(`INSERT INTO catalog_variants (server_id, folder, res_rank, show_key, season) VALUES (0, '/lib/Avatar/Season 01', 1080, 'tmdb:246', 1)`)
	cacheMedia(t, s, "tmdb:media:tv:246", 246, "Avatar: The Last Airbender", "https://img/avatar.jpg")
	e := s.unitEnrichIndex().of("tmdb:246", 1, false)
	if e.title != "Avatar: The Last Airbender" || e.cover != "https://img/avatar.jpg" || e.media.ID != 246 {
		t.Fatalf("enrich: %+v", e)
	}
}

func TestUnitEnrichFoldsAliasRefsOntoTheCanonicalKey(t *testing.T) {
	s, _ := sizeTestServer(t)
	s.Tmdb = tmdb.New(s.DB)
	s.DB.Exec(`INSERT INTO series (id, key, title) VALUES (4, 'avatar', 'Avatar')`)
	// local Plex seasons under the TVDB id, the remote copy matched via TMDB;
	// both belong to one series, so the unit is keyed tvdb:74852 - which no
	// match ever fetched a cover for
	s.DB.Exec(`INSERT INTO catalog_variants (server_id, folder, res_rank, show_key, season, series_id) VALUES (0, 'plex:1:s1', 1080, 'tvdb:74852', 1, 4)`)
	s.DB.Exec(`INSERT INTO catalog_variants (server_id, folder, res_rank, show_key, season, series_id) VALUES (1, '/seed/Avatar', 2160, 'tmdb:246', 1, 4)`)
	s.DB.Exec(`INSERT INTO catalog_matches (server_id, folder, source, media_id) VALUES (1, '/seed/Avatar', 'tmdb:tv', 246)`)
	cacheMedia(t, s, "tmdb:media:tv:246", 246, "Avatar", "https://img/a.jpg")
	e := s.unitEnrichIndex().of("tvdb:74852", 1, false)
	if e.cover != "https://img/a.jpg" || len(e.providers) == 0 {
		t.Fatalf("enrich via alias: %+v", e)
	}
}

func TestUnitEnrichFilesUnmappedAnilistUnderItsFold(t *testing.T) {
	s, _ := sizeTestServer(t)
	s.DB.Exec(`INSERT INTO catalog_variants (server_id, folder, res_rank, show_key, season) VALUES (1, '/seed/Riddle', 1080, 'fold:akuma no riddle', 1)`)
	s.DB.Exec(`INSERT INTO catalog_matches (server_id, folder, source, media_id) VALUES (1, '/seed/Riddle', 'anilist', 20926)`)
	cacheMedia(t, s, "media:20926", 20926, "Akuma no Riddle", "https://img/r.jpg")
	e := s.unitEnrichIndex().of("fold:akuma no riddle", 1, false)
	if e.cover != "https://img/r.jpg" {
		t.Fatalf("enrich via fold: %+v", e)
	}
}
