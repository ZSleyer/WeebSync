package transfer

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/ch4d1/weebsync/internal/dbtest"
	"github.com/ch4d1/weebsync/internal/remote"
)

// The uploader corrected the codec in the names of episodes already synced:
// same episode, same bytes, new name. That is no new release; fetching it again
// put every episode in the library twice. Another size is one, and replaces.
func TestEnqueueLeavesARenamedReleaseThatIsAlreadyHere(t *testing.T) {
	d := dbtest.Open(t)
	d.Exec(`INSERT INTO settings (key, value) VALUES ('max_concurrent', '0')`)
	d.Exec(`INSERT INTO users (email, is_admin) VALUES ('a@example.com', 1)`)
	d.Exec(`INSERT INTO servers (user_id, name, protocol, host, port, username, secret_enc, root_path)
		VALUES (1, 'srv', 'sftp', 'localhost', 22, 'u', X'00', '/')`)
	root := t.TempDir()
	show := filepath.Join(root, "Witch Hat Atelier (2026)")
	if err := os.Mkdir(show, 0o700); err != nil {
		t.Fatal(err)
	}
	for name, size := range map[string]int{
		"S01E04.(WEBDL-1080p).(x264).(AAC 2.0)-(snk).mkv": 100,
		"S01E05.(WEBDL-1080p).(x264).(AAC 2.0)-(snk).mkv": 100,
	} {
		if err := os.WriteFile(filepath.Join(show, name), make([]byte, size), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	dial := func(userID, serverID int64) (remote.Client, string, error) {
		return &multiClient{dir: "/x/Witch Hat Atelier (2026)", entries: []remote.Entry{
			{Name: "S01E04.(WEBDL-1080p).(h265).(AAC 2.0)-(snk).mkv", Path: "/x/Witch Hat Atelier (2026)/S01E04.(WEBDL-1080p).(h265).(AAC 2.0)-(snk).mkv", Size: 100},
			{Name: "S01E05.(WEBDL-1080p).(h265).(AAC 2.0)-(snk).mkv", Path: "/x/Witch Hat Atelier (2026)/S01E05.(WEBDL-1080p).(h265).(AAC 2.0)-(snk).mkv", Size: 120},
			{Name: "S01E06.(WEBDL-1080p).(h265).(AAC 2.0)-(snk).mkv", Path: "/x/Witch Hat Atelier (2026)/S01E06.(WEBDL-1080p).(h265).(AAC 2.0)-(snk).mkv", Size: 100},
		}}, "", nil
	}
	m := NewManager(d, dial, root)
	res, err := m.Enqueue(1, 1, "/x/Witch Hat Atelier (2026)", "Witch Hat Atelier (2026)", nil, nil, false, true, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.IDs) != 2 || res.Skipped != 1 {
		t.Fatalf("queued %d, skipped %d; want E05 (other size) and E06 queued, E04 left", len(res.IDs), res.Skipped)
	}
}
