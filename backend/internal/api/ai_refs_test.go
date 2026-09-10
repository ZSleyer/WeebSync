package api

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

// A ref belongs to the user whose tools minted it, and the tool outputs
// that name folders carry names and refs, never a path or a server id.
func TestAiRefsHidePathsAndStayPerUser(t *testing.T) {
	_, s, _ := setupAiTest(t, newFakeProvider(t))
	s.DB.Exec(`INSERT INTO watches (user_id, server_id, remote_path, local_path) VALUES (1, 1, '/anime/Frieren', '/lib/Anime/Frieren')`)
	s.DB.Exec(`INSERT INTO downloads (user_id, server_id, remote_path, local_path, size, status) VALUES (1, 1, '/anime/Frieren/ep1.mkv', '/lib/Anime/Frieren/ep1.mkv', 1, 'done')`)
	s.DB.Exec(`INSERT INTO catalog_variants (server_id, folder, res_rank, show_key, season) VALUES (0, '/lib/Anime/Frieren/Season 1', 1080, 'tvdb:1', 1)`)

	for name, out := range map[string]any{
		"search_remote": s.aiSearchRemote(1, "Frieren"),
		"my_watches":    s.aiWatches(1),
		"downloads":     s.aiDownloads(1, ""),
		"library":       s.aiLibrary(1, "Frieren"),
	} {
		b, _ := json.Marshal(out)
		got := string(b)
		if strings.Contains(got, "/anime") || strings.Contains(got, "/lib") || strings.Contains(got, "serverId") || strings.Contains(got, "localPath") {
			t.Errorf("%s leaks a path: %s", name, got)
		}
		if !strings.Contains(got, "Frieren") {
			t.Errorf("%s lost the folder name: %s", name, got)
		}
	}

	ref := aiRefKey(1, 1, "/anime/Frieren")
	if srv, p, ok := s.aiDeref(1, ref); !ok || srv != 1 || p != "/anime/Frieren" {
		t.Fatalf("deref own ref: %d %q %v", srv, p, ok)
	}
	if _, _, ok := s.aiDeref(2, ref); ok {
		t.Fatal("another user resolved the ref")
	}
	if _, reason := s.aiPropose(context.Background(), 2, "watch", ref, "Frieren", "", ""); !strings.Contains(reason, "unknown ref") {
		t.Fatalf("propose across users: %q", reason)
	}
}
