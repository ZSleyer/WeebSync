package api

import (
	"fmt"
	"io"
	"strings"
	"sync"
	"testing"

	"github.com/ch4d1/weebsync/internal/dbtest"
	"github.com/ch4d1/weebsync/internal/remote"
	"github.com/ch4d1/weebsync/internal/transfer"
)

// The hourly Plex index refreshes the transfer manager's root allowlist while
// downloads and watch checks resolve their targets against it. The refresh used
// to overwrite the slice header without a lock, a data race the race detector
// reports and that, torn, hands a resolver a length that does not belong to its
// pointer. The refresh and the readers have to be ordered.
func TestPlexRootRefreshDoesNotRaceTransferReaders(t *testing.T) {
	d := dbtest.Open(t)
	d.Exec(`INSERT INTO settings (key, value) VALUES ('max_concurrent', '0')`)
	d.Exec(`INSERT INTO users (email, is_admin) VALUES ('a@example.com', 1)`)
	d.Exec(`INSERT INTO servers (user_id, name, protocol, host, port, username, secret_enc, root_path)
		VALUES (1, 'srv', 'sftp', 'localhost', 22, 'u', X'00', '/')`)
	root := t.TempDir()
	// a season of many files the language filter drops: Enqueue resolves
	// every target against the roots in one pass, with no database call in
	// between that would order it after the write
	dial := func(userID, serverID int64) (remote.Client, string, error) {
		return manyFilesClient{dir: "/x/Show", n: 500}, "", nil
	}
	s := testServer(t, &Server{DB: d, DownloadRoot: root, LocalRoots: []string{root},
		Transfers: transfer.NewManager(d, dial, root)})

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		for range 200 {
			s.storePlexRoots(nil)
		}
	}()
	go func() {
		defer wg.Done()
		for range 50 {
			if _, err := s.Transfers.Enqueue(1, 1, "/x/Show", "Show", nil, func(string) bool { return false }, false, false, false); err != nil {
				t.Error(err)
				return
			}
		}
	}()
	wg.Wait()
}

// manyFilesClient lists n small files in dir and serves none of them.
type manyFilesClient struct {
	dir string
	n   int
}

func (c manyFilesClient) List(p string) ([]remote.Entry, error) {
	out := make([]remote.Entry, c.n)
	for i := range out {
		name := fmt.Sprintf("f%04d.txt", i)
		out[i] = remote.Entry{Name: name, Path: c.dir + "/" + name, Size: 1}
	}
	return out, nil
}

func (c manyFilesClient) Open(p string, offset int64) (io.ReadCloser, error) {
	return io.NopCloser(strings.NewReader("")), nil
}
func (c manyFilesClient) Size(p string) (int64, error) { return 1, nil }
func (c manyFilesClient) Close() error                 { return nil }
