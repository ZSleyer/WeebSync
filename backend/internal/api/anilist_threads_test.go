package api

import (
	"net/http"
	"strings"
	"testing"
)

func socialFake(f *fakeAnilist) {
	f.answer = func(q string, v map[string]any) string {
		switch {
		case strings.Contains(q, "SaveThreadComment"):
			return `{"data":{"SaveThreadComment":{"id":777}}}`
		case strings.Contains(q, "ToggleLikeV2"):
			return `{"data":{"ToggleLikeV2":{"likeCount":5,"isLiked":true}}}`
		case strings.Contains(q, "threadComments"):
			return `{"data":{"Thread":{"id":9,"title":"t","body":"b","likeCount":4,"isLiked":true,"user":{"name":"op"}},
				"Page":{"pageInfo":{},"threadComments":[{"id":1,"comment":"c","likeCount":2,"isLiked":true,"user":{"name":"a"},
				"childComments":[{"id":2,"comment":"r","likeCount":1,"isLiked":true,"user":{"name":"b"}}]}]}}}`
		}
		return `{"data":{}}`
	}
}

func cacheKeys(t *testing.T, s *Server) map[string]bool {
	t.Helper()
	rows, err := s.DB.Query(`SELECT key FROM anilist_cache WHERE key LIKE 'thread1:%'`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var k string
		rows.Scan(&k)
		out[k] = true
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestAnilistRepliesAndLikes(t *testing.T) {
	s, mux, c, fake, d := linkedServer(t)
	socialFake(fake)

	// switch off: refused before AniList hears of it, and the thread reads
	// anonymously
	if rec := doReq(mux, "POST", "/api/anilist/threads/9/comments", `{"comment":"hello"}`, c); rec.Code != http.StatusForbidden {
		t.Fatalf("reply with the switch off: got %d", rec.Code)
	}
	if rec := doReq(mux, "POST", "/api/anilist/likes", `{"id":1,"type":"THREAD_COMMENT"}`, c); rec.Code != http.StatusForbidden {
		t.Fatalf("like with the switch off: got %d", rec.Code)
	}
	if fake.n() != 0 {
		t.Fatalf("a refused write reached AniList")
	}
	if rec := doReq(mux, "GET", "/api/anilist/threads/9", "", c); rec.Code != http.StatusOK || fake.last().Auth != "" {
		t.Fatalf("anonymous read: got %d auth %q", rec.Code, fake.last().Auth)
	}

	d.Exec(`UPDATE users SET anilist_write_social = 1 WHERE id = 1`)
	// with the switch on the reader reads as the user, likes and all
	rec := doReq(mux, "GET", "/api/anilist/threads/9", "", c)
	if rec.Code != http.StatusOK || fake.last().Auth != "Bearer tok" {
		t.Fatalf("user read: got %d auth %q", rec.Code, fake.last().Auth)
	}
	for _, want := range []string{`"likes":4,"isLiked":true`, `"id":2,"body":"r","likes":1,"createdAt":0,"user":{"name":"b"},"isLiked":true`} {
		if !jsonHas(rec.Body.Bytes(), want) {
			t.Errorf("user read lacks %s: %s", want, rec.Body)
		}
	}
	s.DB.Exec(`INSERT INTO anilist_cache (key, payload) VALUES ('thread1:90:1', '{}')`)
	if k := cacheKeys(t, s); !k["thread1:9:1"] || !k["thread1:9:1:u77"] {
		t.Fatalf("pages not cached per viewer: %v", k)
	}

	for body, want := range map[string]int{
		`{"comment":"   "}`: http.StatusBadRequest,
		`{"comment":"` + strings.Repeat("x", 10001) + `"}`: http.StatusBadRequest,
		`{"comment":"hi","parentCommentId":-1}`:            http.StatusBadRequest,
	} {
		if rec := doReq(mux, "POST", "/api/anilist/threads/9/comments", body, c); rec.Code != want {
			t.Errorf("reply %.30s: got %d, want %d", body, rec.Code, want)
		}
	}
	rec = doReq(mux, "POST", "/api/anilist/threads/9/comments", `{"comment":" a reply ","parentCommentId":1}`, c)
	if rec.Code != http.StatusOK || !jsonHas(rec.Body.Bytes(), `{"id":777}`) {
		t.Fatalf("reply: got %d %s", rec.Code, rec.Body)
	}
	last := fake.last()
	if !strings.Contains(last.Query, "parentCommentId: $parent") || last.Vars["c"] != "a reply" || last.Vars["t"] != float64(9) || last.Vars["parent"] != float64(1) {
		t.Fatalf("reply sent %q %v", last.Query, last.Vars)
	}
	// every page of the thread is dropped, another thread's stays
	if k := cacheKeys(t, s); k["thread1:9:1"] || k["thread1:9:1:u77"] || !k["thread1:90:1"] {
		t.Fatalf("after the reply the cache holds %v", k)
	}

	if rec := doReq(mux, "POST", "/api/anilist/likes", `{"id":1,"type":"MEDIA"}`, c); rec.Code != http.StatusBadRequest {
		t.Fatalf("like of an unknown type: got %d", rec.Code)
	}
	rec = doReq(mux, "POST", "/api/anilist/likes", `{"id":1,"type":"THREAD_COMMENT","threadId":9}`, c)
	if rec.Code != http.StatusOK || !jsonHas(rec.Body.Bytes(), `{"liked":true,"likes":5}`) {
		t.Fatalf("like: got %d %s", rec.Code, rec.Body)
	}
	if v := fake.last().Vars; v["type"] != "THREAD_COMMENT" || v["id"] != float64(1) {
		t.Fatalf("like sent %v", v)
	}

	// the per-user budget runs out: six writes in a burst, two spent above
	got := 0
	for range 8 {
		got = doReq(mux, "POST", "/api/anilist/likes", `{"id":1,"type":"THREAD"}`, c).Code
	}
	if got != http.StatusTooManyRequests {
		t.Fatalf("burst of likes: last got %d, want 429", got)
	}
}
