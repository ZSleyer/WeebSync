package api

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/ch4d1/weebsync/internal/anilist"
)

func ep(group, title string, season, n int) pushItem {
	return pushItem{group: group, title: title, season: season, ep: n, name: title, source: "anilist", media: 7, cover: "https://img.example.com/c.jpg"}
}

func TestPushSingleEpisode(t *testing.T) {
	it := ep("g", "Re:Zero", 4, 16)
	it.epName = "The Gate"
	it.local = "/dl/Re:Zero/S04E16.mkv"
	n := buildDownloadPush("en", true, []pushItem{it})
	if n.Title != "Re:Zero" || n.Body != "S04E16 · The Gate" {
		t.Fatalf("got %q / %q", n.Title, n.Body)
	}
	if n.URL != "/title/anilist/7?ep=16&s=4" || n.Icon == "" || n.Urgency != "low" {
		t.Fatalf("link/icon/urgency: %+v", n)
	}
	if len(n.Actions) != 1 || n.Actions[0].Action != "play" || !strings.HasPrefix(n.Data["play"], "/play?server=0&path=%2Fdl") {
		t.Fatalf("play action: %+v %v", n.Actions, n.Data)
	}
	// payload stays JSON-clean: urgency is a header, not a field
	b, _ := json.Marshal(n)
	if strings.Contains(string(b), "rgency") {
		t.Fatalf("urgency leaked into the payload: %s", b)
	}
	// without an episode title, and in German
	it.epName = ""
	if n := buildDownloadPush("de", true, []pushItem{it}); n.Body != "S04E16 geladen" || n.Actions[0].Title != "Abspielen" {
		t.Fatalf("de: %+v", n)
	}
	// a show without seasons
	it.season = 0
	if n := buildDownloadPush("de", true, []pushItem{it}); n.Body != "Folge 16 geladen" {
		t.Fatalf("absolute: %q", n.Body)
	}
}

func TestPushOneSeriesSeveralEpisodes(t *testing.T) {
	items := []pushItem{ep("g", "Re:Zero", 4, 16), ep("g", "Re:Zero", 4, 17), ep("g", "Re:Zero", 4, 18), ep("g", "Re:Zero", 4, 20)}
	n := buildDownloadPush("en", true, items)
	if n.Title != "Re:Zero" || n.Body != "S04E16-18, S04E20 downloaded" {
		t.Fatalf("got %q / %q", n.Title, n.Body)
	}
	if n.URL != "/title/anilist/7" || len(n.Actions) != 0 {
		t.Fatalf("several files: no episode link, no play: %+v", n)
	}
	// no seasons: spelled out once
	for i := range items {
		items[i].season = 0
	}
	if n := buildDownloadPush("de", true, items[:3]); n.Body != "Folge 16-18 geladen" {
		t.Fatalf("absolute run: %q", n.Body)
	}
}

func TestPushSeveralSeries(t *testing.T) {
	items := []pushItem{ep("a", "Re:Zero", 4, 16), ep("a", "Re:Zero", 4, 17), ep("b", "Frieren", 2, 3), ep("c", "Slime", 4, 1), ep("d", "Dandadan", 2, 2)}
	n := buildDownloadPush("en", true, items)
	if n.Title != "5 episodes downloaded" || n.Body != "Re:Zero S04E16-17, Frieren S02E03, Slime S04E01, +1" {
		t.Fatalf("got %q / %q", n.Title, n.Body)
	}
	if n.URL != "/history" || n.Icon != "" || len(n.Actions) != 0 {
		t.Fatalf("several series open the history without icon: %+v", n)
	}
}

func TestPushFailed(t *testing.T) {
	it := ep("g", "Re:Zero", 4, 16)
	it.id, it.reason = 42, "disk full"
	n := buildDownloadPush("en", false, []pushItem{it})
	if n.Title != "Download failed" || n.Body != "Re:Zero S04E16: disk full" || n.Urgency != "normal" {
		t.Fatalf("got %+v", n)
	}
	if n.URL != "/history" || n.Data["retry"] != "/api/downloads/42/resume" || n.Actions[0].Action != "retry" {
		t.Fatalf("retry: %+v", n)
	}
	// a batch: no reason, no retry button (it would be ambiguous)
	n = buildDownloadPush("de", false, []pushItem{it, ep("g", "Re:Zero", 4, 17), ep("h", "Frieren", 2, 3)})
	if n.Title != "3 Downloads fehlgeschlagen" || n.Body != "Re:Zero S04E16-17, Frieren S02E03" || len(n.Actions) != 0 {
		t.Fatalf("batch: %+v", n)
	}
}

func TestCleanFileName(t *testing.T) {
	for in, want := range map[string]string{
		"[SubsPlease] Frieren - 03 (1080p) [ABCD1234].mkv": "Frieren - 03",
		"[Only Tag].mkv": "[Only Tag]",
		"plain.name.mkv": "plain.name",
	} {
		if got := cleanFileName(in); got != want {
			t.Errorf("%q: got %q, want %q", in, got, want)
		}
	}
}

func TestPushTruncatesOnRunes(t *testing.T) {
	long := strings.Repeat("ゆるキャン△", 20)
	it := ep("g", long, 1, 1)
	n := buildDownloadPush("en", true, []pushItem{it})
	if utf8.RuneCountInString(n.Title) != pushTitleMax || !strings.HasSuffix(n.Title, "…") || !utf8.ValidString(n.Title) {
		t.Fatalf("title %q", n.Title)
	}
	it.title = "x"
	it.name = strings.Repeat("y", 300)
	it.ep = 0
	if n := buildDownloadPush("en", true, []pushItem{it}); utf8.RuneCountInString(n.Body) > pushBodyMax {
		t.Fatalf("body %d runes", utf8.RuneCountInString(n.Body))
	}
}

// Nothing matched: the release name carries the show and the episode.
// A matched series goes by the name its watch gives it, not the catalog's
// full romaji: on a phone that title would push the episode out of the line.
func TestPushItemsUseTheWatchName(t *testing.T) {
	s := digestTestServer(t)
	s.Anilist = anilist.New(s.DB)
	s.DB.Exec(`INSERT INTO watches (user_id, server_id, remote_path, local_path, mode, template, title_override)
		VALUES (1, 1, '/x/Show', 'Show', 'template', 'Show - S04E{episode:02}', 'Re:Zero')`)
	s.DB.Exec(`INSERT INTO catalog_matches (server_id, folder, media_id, source) VALUES (1, '/x/Show', 5, 'anilist')`)
	s.DB.Exec(`INSERT INTO anilist_cache (key, payload) VALUES ('media:5', ?)`,
		fmt.Sprintf(`{"id":5,"schema":%d,"status":"FINISHED","title":{"romaji":"Re:Zero kara Hajimeru Isekai Seikatsu 4th Season"}}`, anilist.MediaSchema))
	items := s.pushItems(1, "en", []digestItem{{serverID: 1, remotePath: "/x/Show/Re Zero S4 E16 [JapDub].mkv", localPath: "/dl/Show - S04E16.mkv", id: 5}})
	if items[0].title != "Re:Zero" || items[0].ep != 16 || items[0].source != "anilist" {
		t.Fatalf("got %+v", items[0])
	}
}

func TestPushItemsFallbackWithoutMatch(t *testing.T) {
	s := digestTestServer(t)
	items := s.pushItems(1, "en", []digestItem{
		{serverID: 1, remotePath: "/dl/[SubsPlease] Frieren - 03 (1080p) [ABCD1234].mkv", localPath: "/dl/x.mkv", id: 5},
		{serverID: 1, remotePath: "/dl/mystery.mkv", localPath: "/dl/mystery.mkv", id: 6},
	})
	if items[0].title != "Frieren" || items[0].ep != 3 || items[0].source != "" {
		t.Fatalf("release name: %+v", items[0])
	}
	if items[1].title != "mystery" || items[1].ep != 0 {
		t.Fatalf("bare name: %+v", items[1])
	}
	n := buildDownloadPush("en", true, items[:1])
	if n.Title != "Frieren" || n.Body != "Episode 3 downloaded" || n.URL != "/history" {
		t.Fatalf("got %+v", n)
	}
}
