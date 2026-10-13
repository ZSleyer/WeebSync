package api

import (
	"encoding/json"
	"reflect"
	"strconv"
	"testing"

	"github.com/ch4d1/weebsync/internal/transfer"
)

// What the names advertise: the highest resolution and the languages of both
// names, the remote one included since a rename drops its tags.
func TestFileFacts(t *testing.T) {
	for _, tc := range []struct {
		name, local, remote string
		res                 int
		dub, sub            []string
	}{
		{"tags only in the remote name", "Show - S01E05.mkv", "[Grp] Show - 05 [1080p] [GerJapDub] [GerSub].mkv", 1080, []string{"Ger", "Jap"}, []string{"Ger"}},
		{"both names, no doubles", "Show - S01E05 [720p] [GerDub].mkv", "Show 05 (1080p) [GerEngDub].mkv", 1080, []string{"Ger", "Eng"}, nil},
		{"nothing advertised", "Show - S01E05.mkv", "Show 05.mkv", 0, nil, nil},
		{"4K and short codes", "", "Show 05 [4K] [DeJaDub].mkv", 2160, []string{"Ger", "Jap"}, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			res, dub, sub := fileFacts(tc.local, tc.remote)
			if res != tc.res || !reflect.DeepEqual(dub, tc.dub) || !reflect.DeepEqual(sub, tc.sub) {
				t.Errorf("fileFacts = %d %v %v, want %d %v %v", res, dub, sub, tc.res, tc.dub, tc.sub)
			}
		})
	}
}

func TestRunFacts(t *testing.T) {
	if secs, rate := runFacts("2026-10-12 08:00:00", "2026-10-12 08:01:40", 500_000_000); secs != 100 || rate != 5_000_000 {
		t.Errorf("100 s for 500 MB = %d s %d B/s", secs, rate)
	}
	for _, tc := range [][2]string{{"", "2026-10-12 08:00:00"}, {"2026-10-12 08:00:00", "2026-10-12 08:00:00"}, {"2026-10-12 09:00:00", "2026-10-12 08:00:00"}} {
		if secs, rate := runFacts(tc[0], tc[1], 100); secs != 0 || rate != 0 {
			t.Errorf("runFacts(%q, %q) = %d %d, want nothing", tc[0], tc[1], secs, rate)
		}
	}
}

// The meta item of a done download carries its facts and its run.
func TestDownloadsMetaFacts(t *testing.T) {
	s := metaTestServer(t)
	id := addDownload(t, s, 1, "/a/[Grp] Show - 05 [1080p] [GerJapDub].mkv", "/media/Show/Show - S01E05.mkv")
	s.DB.Exec(`UPDATE downloads SET size = 300, start_bytes = 100, started_at = '2026-10-12 08:00:00', updated_at = '2026-10-12 08:00:40' WHERE id = ?`, id)
	resp, err := s.downloadsMeta(1)
	if err != nil {
		t.Fatal(err)
	}
	it := resp.Items[strconv.FormatInt(id, 10)]
	if it.Res != 1080 || !reflect.DeepEqual(it.Dub, []string{"Ger", "Jap"}) || it.Secs != 40 || it.Rate != 5 {
		t.Errorf("item = %+v", it)
	}
}

// A failed or cancelled row says when it ended too, for the history's timeline.
func TestDownloadsListFinishedAtFailed(t *testing.T) {
	mux, s, adminC, _, _, _ := setupUsersTest(t)
	s.Transfers = transfer.NewManager(s.DB, nil, t.TempDir())
	s.DB.Exec(`INSERT INTO servers (user_id, name, protocol, host, port, username, secret_enc, root_path)
		VALUES (1, 'srv', 'sftp', 'localhost', 22, 'u', X'00', '/')`)
	s.DB.Exec(`INSERT INTO downloads (user_id, server_id, remote_path, local_path, size, status, updated_at)
		VALUES (1, 1, '/a/E03.mkv', 'a', 1, 'error', '2026-10-12 10:00:00'),
		       (1, 1, '/a/E04.mkv', 'a', 1, 'canceled', '2026-10-12 11:00:00')`)
	rec := doReq(mux, "GET", "/api/downloads", "", adminC)
	var list []transfer.Download
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil || len(list) != 2 {
		t.Fatalf("list: %v %s", err, rec.Body)
	}
	for _, d := range list {
		if d.FinishedAt == "" {
			t.Errorf("%s (%s): no finishedAt", d.RemotePath, d.Status)
		}
	}
}
