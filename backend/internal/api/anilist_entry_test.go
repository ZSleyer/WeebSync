package api

import (
	"net/http"
	"strconv"
	"strings"
	"testing"
)

// entryFake answers like AniList for media 9: not on the list until saved,
// a user rating on the 10-point scale.
func entryFake(f *fakeAnilist) {
	saved := false
	f.answer = func(q string, v map[string]any) string {
		switch {
		case strings.Contains(q, "mediaListOptions"):
			return `{"data":{"User":{"mediaListOptions":{"scoreFormat":"POINT_10"}}}}`
		case strings.Contains(q, "SaveMediaListEntry"):
			saved = true
			p, _ := v["p"].(float64)
			return `{"data":{"SaveMediaListEntry":{"id":31,"status":"CURRENT","progress":` + strconv.Itoa(int(p)) + `,"score":80,"repeat":0,"startedAt":{"year":2026,"month":10,"day":1},"completedAt":{},"updatedAt":1760000000}}}`
		case strings.Contains(q, "DeleteMediaListEntry"):
			saved = false
			return `{"data":{"DeleteMediaListEntry":{"deleted":true}}}`
		case strings.Contains(q, "MediaList("):
			if !saved {
				return `{"data":{"MediaList":null},"errors":[{"message":"Not Found.","status":404}]}`
			}
			return `{"data":{"MediaList":{"id":31,"status":"CURRENT","progress":5,"score":80}}}`
		}
		return `{"data":{}}`
	}
}

func TestAnilistEntry(t *testing.T) {
	_, mux, c, fake, d := linkedServer(t)
	entryFake(fake)
	d.Exec(`INSERT INTO anilist_cache (key, payload) VALUES ('media:9', '{"id":9,"episodes":12}')`)

	// a second user without a linked account
	d.Exec(`INSERT INTO users (email, is_admin) VALUES ('other@example.com', 0)`)
	if rec := doReq(mux, "GET", "/api/anilist/entry/9", "", cookieForUser(t, d, 2)); rec.Code != http.StatusOK ||
		!jsonHas(rec.Body.Bytes(), `"linked":false`) {
		t.Fatalf("unlinked: got %d %s", rec.Code, rec.Body)
	}

	// not on the list: AniList's 404 reads as no entry, not as a failure
	rec := doReq(mux, "GET", "/api/anilist/entry/9", "", c)
	if rec.Code != http.StatusOK {
		t.Fatalf("missing entry: got %d %s", rec.Code, rec.Body)
	}
	for _, want := range []string{`"linked":true`, `"canEdit":false`, `"scoreFormat":"POINT_10"`, `"episodes":12`, `"entry":null`} {
		if !jsonHas(rec.Body.Bytes(), want) {
			t.Errorf("missing entry body lacks %s: %s", want, rec.Body)
		}
	}
	if fake.last().Auth != "Bearer tok" {
		t.Errorf("the entry must be read with the user's token, got %q", fake.last().Auth)
	}

	// writes wait for the switch, and never reach AniList before it
	before := fake.n()
	if rec := doReq(mux, "PUT", "/api/anilist/entry/9", `{"progress":5}`, c); rec.Code != http.StatusForbidden {
		t.Fatalf("switch off: got %d", rec.Code)
	}
	if rec := doReq(mux, "DELETE", "/api/anilist/entry/9", "", c); rec.Code != http.StatusForbidden {
		t.Fatalf("switch off delete: got %d", rec.Code)
	}
	if fake.n() != before {
		t.Fatalf("a refused write reached AniList")
	}
	doReq(mux, "PUT", "/api/anilist/permissions", `{"list":true}`, c)

	for body, want := range map[string]int{
		`{}`:                           http.StatusBadRequest,
		`{"status":"WATCHING"}`:        http.StatusBadRequest,
		`{"progress":13}`:              http.StatusBadRequest,
		`{"progress":-1}`:              http.StatusBadRequest,
		`{"scoreRaw":101}`:             http.StatusBadRequest,
		`{"progress":5,"scoreRaw":80}`: http.StatusOK,
	} {
		if rec := doReq(mux, "PUT", "/api/anilist/entry/9", body, c); rec.Code != want {
			t.Errorf("PUT %s: got %d, want %d (%s)", body, rec.Code, want, rec.Body)
		}
	}
	// only the given fields go out
	var save fakeCall
	for _, call := range fake.calls {
		if strings.Contains(call.Query, "SaveMediaListEntry") {
			save = call
		}
	}
	if strings.Contains(save.Query, "status: $s") || save.Vars["p"] != float64(5) || save.Vars["r"] != float64(80) {
		t.Fatalf("save sent %q %v", save.Query, save.Vars)
	}

	rec = doReq(mux, "DELETE", "/api/anilist/entry/9", "", c)
	if rec.Code != http.StatusOK || !jsonHas(rec.Body.Bytes(), `"entry":null`) {
		t.Fatalf("delete: got %d %s", rec.Code, rec.Body)
	}
	if last := fake.last(); !strings.Contains(last.Query, "DeleteMediaListEntry") || last.Vars["id"] != float64(31) {
		t.Fatalf("delete sent %q %v", last.Query, last.Vars)
	}
}
