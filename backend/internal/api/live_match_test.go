package api

import (
	"slices"
	"testing"
)

// The folders a live-action library got wrong, and the endless anime that
// must keep matching when their tree is ordered by TVDB.
func TestPickLive(t *testing.T) {
	squid := liveCand{383275, 2021, []string{"Squid Game", "오징어 게임"}}
	challenge := liveCand{429617, 2023, []string{"Squid Game: The Challenge"}}
	conan := liveCand{72454, 1996, []string{"Detective Conan", "Meitantei Conan", "Detektiv Conan", "名探偵コナン"}}
	onePiece := liveCand{81797, 1999, []string{"One Piece", "ワンピース"}}
	onePieceLA := liveCand{392276, 2023, []string{"One Piece"}}
	cases := []struct {
		name, query string
		cands       []liveCand
		want        int
	}{
		{"Squid Game (2021)", "Squid Game", []liveCand{challenge, squid}, 383275},
		{"Squid Game (2021)", "Squid Game", []liveCand{challenge}, 0},
		{"The 50 (2024)", "The 50", []liveCand{{1, 2023, []string{"The Bear"}}}, 0},
		{"Monster (2017)", "Monster", []liveCand{{2, 2017, []string{"Super Monsters Monster Pets"}}}, 0},
		{"Invasion (2021)", "Invasion", []liveCand{{3, 2023, []string{"Secret Invasion"}}, {4, 2021, []string{"Invasion"}}}, 4},
		{"1992 (2015)", "1992", []liveCand{{5, 1992, []string{"Ghostwriter"}}}, 0},
		{"Slow Horses - Ein Fall für Jackson Lamb", "Slow Horses", []liveCand{{6, 2022, []string{"Slow Horses"}}}, 6},
		{"Haus des Geldes (2017)", "Haus des Geldes", []liveCand{{7, 2017, []string{"La casa de papel", "Haus des Geldes", "Money Heist"}}}, 7},
		{"Meitantei Conan (Detektiv Conan) [JapDub,GerEngSub,CR]", "Meitantei Conan", []liveCand{conan}, 72454},
		{"Meitantei Conan (Detektiv Conan) [JapDub,GerEngSub,CR]", "Detektiv Conan", []liveCand{conan}, 72454},
		{"One Piece (1999)", "One Piece", []liveCand{onePieceLA, onePiece}, 81797},
		{"One Piece (2023)", "One Piece", []liveCand{onePiece, onePieceLA}, 392276},
		// no year to tell the anime from the series: Plex decides, not a guess
		{"One Piece [JapDub,GerSub,CR]", "One Piece", []liveCand{onePieceLA, onePiece}, 0},
		{"One Piece [JapDub,GerSub,CR]", "One Piece", []liveCand{onePiece}, 81797},
	}
	for _, c := range cases {
		if got := pickLive(c.name, c.query, c.cands); got != c.want {
			t.Errorf("pickLive(%q, %q) = %d, want %d", c.name, c.query, got, c.want)
		}
	}
}

func TestLiveQueries(t *testing.T) {
	s := sourceTestServer(t)
	s.DB.Exec(`INSERT INTO remote_index (server_id, path, name, parent, is_dir) VALUES
		(1, '/s/Lockerbie (2025)/Lockerbie.A.Search.for.Truth.S01E01.GERMAN.DL.1080p.WEB.h264-SAUERKRAUT.mkv',
		 'Lockerbie.A.Search.for.Truth.S01E01.GERMAN.DL.1080p.WEB.h264-SAUERKRAUT.mkv', '/s/Lockerbie (2025)', 0)`)
	qs := s.liveQueries(1, "/s/Lockerbie (2025)", "Lockerbie (2025)")
	if !slices.Contains(qs, "Lockerbie A Search for Truth") {
		t.Errorf("release title missing: %q", qs)
	}
	qs = s.liveQueries(1, "/s/x", "Band of Brothers – Wir waren wie Brüder")
	if !slices.Contains(qs, "Band of Brothers") {
		t.Errorf("title before the dash missing: %q", qs)
	}
}
