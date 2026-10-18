package api

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/dbtest"
)

func TestMissingEpisodes(t *testing.T) {
	// set builds a season-encoded key set from (season, episode) pairs, through
	// the very helper the production code encodes with.
	set := func(pairs ...[2]int) map[int]bool {
		m := map[int]bool{}
		for _, p := range pairs {
			m[epKey(p[0], p[1])] = true
		}
		return m
	}
	// s1 encodes a set of season-1 episode numbers.
	s1 := func(eps ...int) map[int]bool {
		m := map[int]bool{}
		for _, e := range eps {
			m[epKey(1, e)] = true
		}
		return m
	}
	cases := []struct {
		name string
		nums map[int]bool
		want []EpRef
	}{
		{"gap in middle", s1(1, 2, 3, 5), []EpRef{{1, 4}}},
		{"multiple gaps", s1(1, 4, 6), []EpRef{{1, 2}, {1, 3}, {1, 5}}},
		{"no gaps", s1(1, 2, 3), nil},
		{"empty", set(), nil},
		{"single episode", s1(5), nil},
		{"offset span", s1(31, 32, 34), []EpRef{{1, 33}}},
		{"partial start not counted", s1(5, 6, 7), nil}, // 1-4 absent = partial start, not a gap
		// aired-mapping: season-encoded keys. Gaps stay per season - the
		// cross-season range (S21E138 -> S22E01) is NOT a gap.
		{"multi-season no cross gap", set([2]int{21, 135}, [2]int{21, 136}, [2]int{21, 138}, [2]int{22, 1}, [2]int{22, 2}, [2]int{23, 1}), []EpRef{{21, 137}}},
		{"multi-season gap each", set([2]int{1, 1}, [2]int{1, 3}, [2]int{2, 5}, [2]int{2, 7}), []EpRef{{1, 2}, {2, 6}}},
		// season 0 = specials (sparse numbering), never reported as gaps.
		{"specials ignored", set([2]int{0, 57}, [2]int{0, 59}, [2]int{0, 60}), nil},
	}
	for _, c := range cases {
		got := missingEpisodes(c.nums)
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: missingEpisodes(%v) = %v, want %v", c.name, c.nums, got, c.want)
		}
	}
}

// A stray "S01E1208" - an absolute number left in the episode field - used to
// collide with S02E208 under a stride of 1000, handing season 2 a span of
// 1..208 and reporting 181 gaps for a season that was complete. That is exactly
// what Detective Conan looked like in production.
func TestEpKeyDoesNotCollideAcrossSeasons(t *testing.T) {
	if epKey(1, 1208) == epKey(2, 208) {
		t.Fatalf("S01E1208 and S02E208 share key %d", epKey(1, 1208))
	}
	for _, c := range [][2]int{{1, 1208}, {2, 208}, {34, 999}, {0, 12}} {
		se, ep := splitEpKey(epKey(c[0], c[1]))
		if se != c[0] || ep != c[1] {
			t.Errorf("S%02dE%d round-tripped to S%02dE%d", c[0], c[1], se, ep)
		}
	}
	// and an out-of-range number must never reach the map in the first place,
	// or it would give its own season a span reaching up to 1208
	if maxEpisode >= 1000 {
		t.Errorf("maxEpisode = %d lets an absolute number pass as an episode", maxEpisode)
	}
}

func TestDubProgressOf(t *testing.T) {
	tags := func(pairs ...any) map[int]string {
		m := map[int]string{}
		for i := 0; i < len(pairs); i += 2 {
			p := pairs[i].([2]int)
			m[epKey(p[0], p[1])] = pairs[i+1].(string)
		}
		return m
	}
	// the GerDub reaches E12 of 19, the rest is JapDub only
	rz := map[int]string{}
	for e := 1; e <= 19; e++ {
		rz[epKey(3, e)] = "JapDub,"
		if e <= 12 {
			rz[epKey(3, e)] = "GerJapDub,"
		}
	}
	got := dubProgressOf(rz)
	want := &DubProgress{Lang: "Ger", Have: 12, Total: 19, Next: EpRef{3, 13}}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("trailing GerDub = %+v, want %+v", got, want)
	}
	// a finished, dubbed season beside it does not count into the progress
	for e := 1; e <= 16; e++ {
		rz[epKey(2, e)] = "GerJapDub,"
	}
	if got := dubProgressOf(rz); !reflect.DeepEqual(got, want) {
		t.Errorf("with a dubbed season before = %+v, want %+v", got, want)
	}
	for name, m := range map[string]map[int]string{
		"dub reaches the end": tags([2]int{1, 1}, "GerJapDub,", [2]int{1, 2}, "JapGerDub,"),
		"japanese only":       tags([2]int{1, 1}, "JapDub,", [2]int{1, 2}, "JapDub,"),
		"no tags":             tags([2]int{1, 1}, "", [2]int{1, 2}, ""),
		"specials only dub":   tags([2]int{0, 1}, "GerDub,", [2]int{1, 1}, "JapDub,"),
		// the newest file says nothing, so nothing is known to trail
		"newest untagged": tags([2]int{1, 1}, "GerJapDub,", [2]int{1, 2}, ""),
	} {
		if p := dubProgressOf(m); p != nil {
			t.Errorf("%s: got %+v, want none", name, p)
		}
	}
	// no original is assumed: live action in English or in German, with the
	// other language trailing; De and Ger are one language
	for name, c := range map[string]struct {
		m    map[int]string
		lang string
	}{
		"english original": {tags([2]int{1, 1}, "GerEngDub,", [2]int{1, 2}, "EngDub,"), "Ger"},
		"german original":  {tags([2]int{1, 1}, "EngGerDub,", [2]int{1, 2}, "DeDub,"), "Eng"},
	} {
		if p := dubProgressOf(c.m); p == nil || p.Lang != c.lang || p.Next != (EpRef{1, 2}) {
			t.Errorf("%s: got %+v, want %s trailing from S01E02", name, p, c.lang)
		}
	}
	// across seasons: the next episode carries its season
	ms := tags([2]int{1, 12}, "GerJapDub,", [2]int{2, 1}, "GerJapDub,", [2]int{2, 2}, "JapDub,")
	if p := dubProgressOf(ms); p == nil || p.Next != (EpRef{2, 2}) {
		t.Errorf("multi-season next = %+v, want S02E02", p)
	}
}

// Re:Zero as it lay on disk: renamed without a {dub} token, so only the
// releases the files came from say that the GerDub stops at E02 of E04.
func TestDubProgressFromDownloadSources(t *testing.T) {
	d := dbtest.Open(t)
	root := t.TempDir()
	s := testServer(t, &Server{DB: d, Anilist: anilist.New(d), DownloadRoot: root, LocalRoots: []string{root}})
	if err := os.Mkdir(filepath.Join(root, "Show"), 0o755); err != nil {
		t.Fatal(err)
	}
	d.Exec(`INSERT INTO users (email, is_admin) VALUES ('a@example.com', 1)`)
	d.Exec(`INSERT INTO servers (user_id, name, protocol, host, port, username, secret_enc, root_path)
		VALUES (1, 'srv', 'sftp', 'localhost', 22, 'u', X'00', '/')`)
	for e, tag := range map[int]string{1: "GerJapDub", 2: "GerJapDub", 3: "JapDub", 4: "JapDub"} {
		name := fmt.Sprintf("Show_-_S01E%02d.mkv", e)
		if err := os.WriteFile(filepath.Join(root, "Show", name), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
		d.Exec(`INSERT INTO downloads (user_id, server_id, remote_path, local_path, status) VALUES (1, 1, ?, ?, 'done')`,
			// the history keeps absolute paths, the watch a root-relative one
			fmt.Sprintf("/x/Show/Show S1 E%02d [%s].mkv", e, tag), filepath.Join(root, "Show", name))
	}
	d.Exec(`INSERT INTO watches (user_id, server_id, remote_path, local_path, mode, template)
		VALUES (1, 1, '/x/Show', 'Show', 'template', 'Show - S01E{episode:02}')`)
	d.Exec(`INSERT INTO catalog_matches (server_id, folder, media_id, source) VALUES (1, '/x/Show', 5, 'anilist')`)
	d.Exec(`INSERT INTO anilist_cache (key, payload) VALUES ('media:5', ?)`,
		fmt.Sprintf(`{"id":5,"schema":%d,"status":"FINISHED","episodes":4}`, anilist.MediaSchema))

	list, err := s.watchesFor(1)
	if err != nil || len(list) != 1 {
		t.Fatalf("watches: %v, %d", err, len(list))
	}
	w := list[0]
	want := &DubProgress{Lang: "Ger", Have: 2, Total: 4, Next: EpRef{1, 3}}
	if !reflect.DeepEqual(w.DubProgress, want) || w.Complete {
		t.Errorf("dubProgress = %+v, complete = %v; want %+v, not complete", w.DubProgress, w.Complete, want)
	}

	// once the recorder has the originals and the dub's releases, the next
	// dubbed episode is dated at the observed lag
	day := int64(86400)
	orig := time.Now().Unix() - 30*day
	for e := 1; e <= 4; e++ {
		d.Exec(`INSERT INTO airings (source, media_id, airing_at, episode, lang) VALUES ('anilist', 5, ?, ?, '')`, orig+int64(e)*7*day, e)
	}
	for e := 1; e <= 2; e++ {
		d.Exec(`INSERT INTO airings (source, media_id, airing_at, episode, lang) VALUES ('anilist', 5, ?, ?, 'de')`, orig+int64(e)*7*day+21*day, e)
	}
	list, _ = s.watchesFor(1)
	if p := list[0].DubProgress; p == nil || p.ExpectedAt != orig+3*7*day+21*day || p.Released {
		t.Errorf("dubProgress = %+v, want episode 3 expected 21 days after its original", p)
	}
	// the dub of episode 3 came out but the source has not caught up: the
	// real release, not the forecast
	out := orig + 3*7*day + 7*day // two days ago
	d.Exec(`INSERT INTO airings (source, media_id, airing_at, episode, lang) VALUES ('anilist', 5, ?, 3, 'de')`, out)
	list, _ = s.watchesFor(1)
	if p := list[0].DubProgress; p == nil || p.ExpectedAt != out || !p.Released {
		t.Errorf("dubProgress = %+v, want episode 3 released at %d", p, out)
	}
}

func TestBehindLate(t *testing.T) {
	now := time.Unix(1_000_000_000, 0)
	h := int64(time.Hour / time.Second)
	recent := []Airing{{At: now.Unix() - 3*h, Episode: 7}}
	if behindLate(1, recent, "", now) {
		t.Error("one episode aired 3h ago is the usual upload lag")
	}
	if !behindLate(2, recent, "", now) {
		t.Error("two behind with one recent airing: the older one is late")
	}
	old := []Airing{{At: now.Unix() - 72*h, Episode: 7}}
	if !behindLate(1, old, "", now) {
		t.Error("an episode aired three days ago is late")
	}
	if !behindLate(1, recent, "de", now) {
		t.Error("an original slot does not explain a dub watch's backlog")
	}
}
