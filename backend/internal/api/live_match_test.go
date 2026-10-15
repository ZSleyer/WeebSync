package api

import (
	"slices"
	"testing"
)

func cand(id, year int, titles ...string) liveCand {
	return liveCand{id: id, year: year, titles: titles}
}

// The folders a live-action library got wrong, and the endless anime that
// must keep matching when their tree is ordered by TVDB.
func TestPickLive(t *testing.T) {
	squid := cand(383275, 2021, "Squid Game", "오징어 게임")
	challenge := cand(429617, 2023, "Squid Game: The Challenge")
	conan := cand(72454, 1996, "Detective Conan", "Meitantei Conan", "Detektiv Conan", "名探偵コナン")
	conan.anime = true
	onePiece := cand(81797, 1999, "One Piece", "ワンピース")
	onePiece.anime = true
	onePieceLA := cand(392276, 2023, "One Piece")
	twd := cand(153021, 2010, "The Walking Dead")
	twdOnes := cand(445590, 2024, "The Walking Dead: The Ones Who Live")
	cote := cand(329822, 2017, "Classroom of the Elite", "Youkoso Jitsuryoku Shijou Shugi no Kyoushitsu e")
	cote.anime = true
	cases := []struct {
		name, accept string
		cands        []liveCand
		want         int
	}{
		{"Squid Game (2021)", "Squid Game", []liveCand{challenge, squid}, 383275},
		{"Squid Game (2021)", "Squid Game", []liveCand{challenge}, 0},
		{"The 50 (2024)", "The 50", []liveCand{cand(1, 2023, "The Bear")}, 0},
		{"Monster (2017)", "Monster", []liveCand{cand(2, 2017, "Super Monsters Monster Pets")}, 0},
		{"Invasion (2021)", "Invasion", []liveCand{cand(3, 2023, "Secret Invasion"), cand(4, 2021, "Invasion")}, 4},
		{"1992 (2015)", "1992", []liveCand{cand(5, 1992, "Ghostwriter")}, 0},
		{"Slow Horses - Ein Fall für Jackson Lamb", "Slow Horses", []liveCand{cand(6, 2022, "Slow Horses")}, 6},
		{"Haus des Geldes (2017)", "Haus des Geldes", []liveCand{cand(7, 2017, "La casa de papel", "Haus des Geldes", "Money Heist")}, 7},
		{"Meitantei Conan (Detektiv Conan) [JapDub,GerEngSub,CR]", "Meitantei Conan", []liveCand{conan}, 72454},
		{"Meitantei Conan (Detektiv Conan) [JapDub,GerEngSub,CR]", "Detektiv Conan", []liveCand{conan}, 72454},
		{"One Piece (1999)", "One Piece", []liveCand{onePieceLA, onePiece}, 81797},
		{"One Piece (2023)", "One Piece", []liveCand{onePiece, onePieceLA}, 392276},
		// no year, but a Japanese release: the anime, not the live-action series
		{"One Piece [JapDub,GerSub,CR]", "One Piece", []liveCand{onePieceLA, onePiece}, 81797},
		{"One Piece [GerJapDub,GerSub,DVD+BD,ABJ]", "One Piece", []liveCand{onePieceLA, onePiece}, 81797},
		// no year and nothing Japanese: no guess between the two
		{"One Piece", "One Piece", []liveCand{onePieceLA, onePiece}, 0},
		{"One Piece [JapDub,GerSub,CR]", "One Piece", []liveCand{onePiece}, 81797},
		// a season of the one TVDB entry
		{"Youkoso Jitsuryoku Shijou Shugi no Kyoushitsu e 3th Season (Classroom of the Elite 3th Season) [GerJapDub,GerEngSub,CR]",
			"Classroom of the Elite", []liveCand{cote}, 329822},
		// the colon the folder lost: searched under the main title, which the
		// folder does not name, so only the subtitled show is taken
		{"The Walking Dead The Ones Who Live (2024)", "", []liveCand{twd, twdOnes}, 445590},
		{"The Walking Dead The Ones Who Live", "", []liveCand{twd}, 0},
	}
	for _, c := range cases {
		if got := pickLive(c.name, c.accept, c.cands); got != c.want {
			t.Errorf("pickLive(%q, %q) = %d, want %d", c.name, c.accept, got, c.want)
		}
	}
}

func TestLiveQueries(t *testing.T) {
	s := sourceTestServer(t)
	s.DB.Exec(`INSERT INTO remote_index (server_id, path, name, parent, is_dir) VALUES
		(1, '/s/Lockerbie (2025)/Lockerbie.A.Search.for.Truth.S01E01.GERMAN.DL.1080p.WEB.h264-SAUERKRAUT.mkv',
		 'Lockerbie.A.Search.for.Truth.S01E01.GERMAN.DL.1080p.WEB.h264-SAUERKRAUT.mkv', '/s/Lockerbie (2025)', 0)`)
	has := func(qs []liveQuery, q string, accepted bool) bool {
		return slices.ContainsFunc(qs, func(l liveQuery) bool { return l.q == q && (l.accept != "") == accepted })
	}
	qs := s.liveQueries(1, "/s/Lockerbie (2025)", "Lockerbie (2025)")
	if !has(qs, "Lockerbie A Search for Truth", true) {
		t.Errorf("release title missing: %v", qs)
	}
	qs = s.liveQueries(1, "/s/x", "Band of Brothers – Wir waren wie Brüder")
	if !has(qs, "Band of Brothers", true) {
		t.Errorf("title before the dash missing: %v", qs)
	}
	qs = s.liveQueries(1, "/s/x", "Tomb Raider The Legend of Lara Croft (2024)")
	if !has(qs, "Tomb Raider", false) {
		t.Errorf("main title is searched, not taken: %v", qs)
	}
	qs = s.liveQueries(1, "/s/x", "Yi Ren Zhi Xia 3 (Hitori no Shita The Outcast 3) [ChiDub,GerEngSub,CR]")
	if !has(qs, "Hitori no Shita The Outcast", true) {
		t.Errorf("season marker kept: %v", qs)
	}
}
